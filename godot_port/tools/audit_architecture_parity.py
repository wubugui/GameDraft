#!/usr/bin/env python3
"""Fail-closed structural parity audit for the TypeScript and Godot shells."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PORT = ROOT / "godot_port"
CONTRACT = json.loads((PORT / "compatibility/architecture-contract.json").read_text(encoding="utf-8"))
CODE_TRANSLATION_CONTRACT = json.loads((PORT / "compatibility/code-translation-contract.json").read_text(encoding="utf-8"))


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def section(text: str, start: str, end: str) -> str:
    left = text.find(start)
    if left < 0:
        return ""
    right = text.find(end, left + len(start))
    return text[left:] if right < 0 else text[left:right]


def gd_function(text: str, name: str) -> str:
    """Return one top-level GDScript function without swallowing its neighbours."""
    match = re.search(rf"^(?:static )?func {re.escape(name)}\(", text, flags=re.MULTILINE)
    if match is None:
        return ""
    next_match = re.search(r"^(?:static )?func [A-Za-z_]", text[match.end():], flags=re.MULTILINE)
    if next_match is None:
        return text[match.start():]
    return text[match.start():match.end() + next_match.start()]


errors: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def ordered_tokens(text: str, tokens: list[str]) -> bool:
    cursor = -1
    for token in tokens:
        cursor = text.find(token, cursor + 1)
        if cursor < 0:
            return False
    return True


def snake_case(name: str) -> str:
    first = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return re.sub(r"([A-Z])([A-Z][a-z])", r"\1_\2", first).lower()


translation_modules = CODE_TRANSLATION_CONTRACT.get("modules", [])
translation_sources = [entry.get("source") for entry in translation_modules if isinstance(entry, dict)]
production_sources = sorted(
    str(path.relative_to(ROOT))
    for path in (ROOT / "src").rglob("*.ts")
    if not path.name.endswith(".test.ts")
)
require(sorted(translation_sources) == production_sources, "code-translation-contract.json does not inventory every executable TypeScript module")
require(len(translation_sources) == len(set(translation_sources)), "code-translation-contract.json contains duplicate TypeScript modules")
for entry in translation_modules:
    source = entry.get("source")
    target = entry.get("target")
    status = entry.get("status")
    require(isinstance(source, str) and (ROOT / source).is_file(), f"translation ledger source missing: {source}")
    require(status in {"verified-direct", "translating", "audit-required", "missing", "engine-adapter", "browser-platform-only", "declaration-only", "barrel-only"}, f"translation ledger status invalid: {entry}")
    if target is not None:
        require(isinstance(target, str) and (ROOT / target).is_file(), f"translation ledger target missing: {target}")
    if status == "missing":
        require(target is None, f"translation ledger missing module unexpectedly claims target: {entry}")
    if status in {"verified-direct", "engine-adapter"}:
        require(target is not None, f"translation ledger completed runtime module has no target: {entry}")
    if status in {"browser-platform-only", "declaration-only", "barrel-only"}:
        require(target is None, f"translation ledger non-runtime module unexpectedly claims target: {entry}")

unresolved_translation_modules = [
    str(entry.get("source"))
    for entry in translation_modules
    if entry.get("status") in {"translating", "audit-required", "missing"}
]
require(
    not unresolved_translation_modules,
    "code translation remains unresolved: " + ", ".join(unresolved_translation_modules),
)


def extract_action_registrations(text: str) -> list[tuple[str, list[str]]]:
    """Read executor.register(type, handler, paramNames) without depending on TS/GDScript ASTs."""
    output: list[tuple[str, list[str]]] = []
    marker = "executor.register("
    cursor = 0
    while True:
        start = text.find(marker, cursor)
        if start < 0:
            return output
        body_start = start + len(marker)
        index = body_start
        paren = bracket = brace = 0
        quote = ""
        escaped = False
        line_comment = False
        block_comment = False
        commas: list[int] = []
        while index < len(text):
            char = text[index]
            nxt = text[index + 1] if index + 1 < len(text) else ""
            if line_comment:
                if char == "\n":
                    line_comment = False
                index += 1
                continue
            if block_comment:
                if char == "*" and nxt == "/":
                    block_comment = False
                    index += 2
                else:
                    index += 1
                continue
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = ""
                index += 1
                continue
            if char in "'\"`":
                quote = char
                index += 1
                continue
            if char == "/" and nxt == "/":
                line_comment = True
                index += 2
                continue
            if char == "/" and nxt == "*":
                block_comment = True
                index += 2
                continue
            if char == "#":
                line_comment = True
                index += 1
                continue
            if char == "(":
                paren += 1
            elif char == ")":
                if paren == 0 and bracket == 0 and brace == 0:
                    break
                paren -= 1
            elif char == "[":
                bracket += 1
            elif char == "]":
                bracket -= 1
            elif char == "{":
                brace += 1
            elif char == "}":
                brace -= 1
            elif char == "," and paren == 0 and bracket == 0 and brace == 0:
                commas.append(index)
            index += 1
        call = text[body_start:index]
        action_match = re.match(r"\s*['\"]([^'\"]+)['\"]", call)
        if action_match and commas:
            last_start = commas[-1] + 1
            last_end = index
            if not text[last_start:last_end].strip() and len(commas) > 1:
                last_start = commas[-2] + 1
                last_end = commas[-1]
            last_arg = text[last_start:last_end]
            names = re.findall(r"['\"]([^'\"]+)['\"]", last_arg)
            output.append((action_match.group(1), names))
        cursor = index + 1


game = read("src/core/Game.ts")
bootstrap = read("godot_port/scripts/bootstrap.gd")
run_tests = read("godot_port/tools/run_tests.py")
runtime_root = read("godot_port/scripts/runtime/runtime_root.gd")
ts_bridge = read("src/core/EventBridge.ts")
gd_bridge = read("godot_port/scripts/core/event_bridge.gd")
action_executor = read("godot_port/scripts/runtime/action_executor.gd")
action_registry = read("godot_port/scripts/runtime/action_registry.gd")
action_param_manifest = read("godot_port/scripts/runtime/action_param_manifest.gd")
ts_event_bus = read("src/core/EventBus.ts")
gd_event_bus = read("godot_port/scripts/runtime/event_bus.gd")
ts_flag_store = read("src/core/FlagStore.ts")
gd_flag_store = read("godot_port/scripts/runtime/flag_store.gd")
ts_rule_offer_registry = read("src/core/RuleOfferRegistry.ts")
gd_rule_offer_registry = read("godot_port/scripts/systems/rule_offer_registry.gd")
ts_game_state_controller = read("src/core/GameStateController.ts")
gd_game_state_controller = read("godot_port/scripts/runtime/game_state_controller.gd")
ts_strings_provider = read("src/core/StringsProvider.ts")
gd_strings_provider = read("godot_port/scripts/runtime/strings_provider.gd")
ts_asset_manager = read("src/core/AssetManager.ts")
gd_asset_manager = read("godot_port/scripts/runtime/asset_manager.gd")
ts_text_resolver = read("src/core/resolveText.ts")
gd_text_resolver = read("godot_port/scripts/runtime/text_resolver.gd")
gd_rich_content = read("godot_port/scripts/ui/rich_content.gd")
ts_input_manager = read("src/core/InputManager.ts")
gd_input_manager = read("godot_port/scripts/runtime/input_manager.gd")
ts_flag_keys = read("src/core/FlagKeys.ts")
gd_flag_keys = read("godot_port/scripts/runtime/flag_keys.gd")
ts_character_registry = read("src/data/characterRegistry.ts")
gd_character_registry = read("godot_port/scripts/data/character_registry.gd")
ts_data_types = read("src/data/types.ts")
gd_data_types = read("godot_port/scripts/data/data_types.gd")
ts_day_manager = read("src/systems/DayManager.ts")
gd_day_manager = read("godot_port/scripts/systems/day_manager.gd")
ts_health_system = read("src/systems/HealthSystem.ts")
gd_health_system = read("godot_port/scripts/systems/health_system.gd")
ts_dialogue_manager = read("src/systems/DialogueManager.ts")
gd_dialogue_manager = read("godot_port/scripts/systems/dialogue_manager.gd")
ts_scenario_state_manager = read("src/core/ScenarioStateManager.ts")
gd_scenario_state_manager = read("godot_port/scripts/systems/scenario_state_manager.gd")
gd_async_latch = read("godot_port/scripts/runtime/async_latch.gd")
gd_microtask_queue = read("godot_port/scripts/runtime/microtask_queue.gd")
gd_async_tail = read("godot_port/scripts/runtime/async_tail.gd")
ts_interaction = read("src/core/InteractionCoordinator.ts")
interaction = read("godot_port/scripts/core/interaction_coordinator.gd")
ts_interaction_system = read("src/systems/InteractionSystem.ts")
gd_interaction_system = read("godot_port/scripts/systems/interaction_system.gd")
ts_signal_cue_manager = read("src/systems/SignalCueManager.ts")
gd_signal_cue_manager = read("godot_port/scripts/systems/signal_cue_manager.gd")
ts_hotspot_interaction = read("src/utils/hotspotInteraction.ts")
gd_hotspot_interaction = read("godot_port/scripts/runtime/hotspot_interaction.gd")
ts_condition_evaluator = read("src/systems/graphDialogue/evaluateGraphCondition.ts")
gd_condition_evaluator = read("godot_port/scripts/runtime/condition_evaluator.gd")
ts_condition_bridge = read("src/systems/graphDialogue/conditionEvalBridge.ts")
gd_condition_bridge = read("godot_port/scripts/runtime/condition_eval_bridge.gd")
ts_graph_dialogue_manager = read("src/systems/GraphDialogueManager.ts")
ts_document_reveal_manager = read("src/systems/DocumentRevealManager.ts")
gd_document_reveal_manager = read("godot_port/scripts/systems/document_reveal_manager.gd")
ts_map_ui = read("src/ui/MapUI.ts")
gd_map_ui = read("godot_port/scripts/ui/map_ui.gd")
ts_depth_floor_zones = read("src/utils/depthFloorZones.ts")
gd_depth_floor_zones = read("godot_port/scripts/runtime/depth_floor_zones.gd")
ts_save_manager = read("src/core/SaveManager.ts")
gd_save_manager = read("godot_port/scripts/runtime/save_manager.gd")
gd_local_storage = read("godot_port/scripts/runtime/local_storage.gd")
gd_menu_ui = read("godot_port/scripts/ui/menu_ui.gd")
gd_game_startup_adapter = read("godot_port/scripts/runtime/game_startup_adapter.gd")
ts_dev_runtime_commands = read("src/core/devRuntimeCommands.ts")
dev_runtime_commands = read("godot_port/scripts/core/dev_runtime_commands.gd")
gd_javascript_runtime_adapter = read("godot_port/scripts/runtime/javascript_runtime_adapter.gd")
ts_hold_progress = read("src/systems/pressureHold/holdProgress.ts")
gd_hold_progress = read("godot_port/scripts/systems/hold_progress.gd")
ts_pressure_hold_manager = read("src/systems/pressureHold/PressureHoldManager.ts")
ts_minigame_session = read("src/systems/minigameSession.ts")
gd_minigame_session = read("godot_port/scripts/minigames/minigame_session.gd")
gd_minigame_action_gate = read("godot_port/scripts/minigames/minigame_action_playback_gate.gd")
ts_minigame_script = read("src/systems/minigameScript.ts")
gd_minigame_script = read("godot_port/scripts/minigames/minigame_script_runner.gd")
gd_sugar_wheel_atmosphere = read("godot_port/scripts/minigames/sugar_wheel_atmosphere.gd")
ts_sugar_wheel_atmosphere = read("src/systems/sugarWheel/sugarWheelAtmosphere.ts")
ts_paper_craft_manager = read("src/systems/paperCraft/PaperCraftMinigameManager.ts")
gd_paper_craft_manager = read("godot_port/scripts/minigames/paper_craft_manager.gd")
ts_paper_craft_scene = read("src/systems/paperCraft/PaperCraftMinigameScene.ts")
gd_paper_craft_scene = read("godot_port/scripts/minigames/paper_craft_scene.gd")
ts_fill_template = read("src/utils/fillTemplate.ts")
gd_fill_template = read("godot_port/scripts/utils/fill_template.gd")
ts_sugar_wheel_manager = read("src/systems/sugarWheel/SugarWheelMinigameManager.ts")
gd_sugar_wheel_manager = read("godot_port/scripts/minigames/sugar_wheel_manager.gd")
ts_sugar_wheel_spin_physics = read("src/systems/sugarWheel/sugarWheelSpinPhysics.ts")
gd_sugar_wheel_spin_physics = read("godot_port/scripts/minigames/sugar_wheel_spin_physics.gd")
ts_water_manager = read("src/systems/waterMinigame/WaterMinigameManager.ts")
gd_water_manager = read("godot_port/scripts/minigames/water_manager.gd")
ts_water_pull_panel = read("src/systems/waterMinigame/WaterPullPanel.ts")
gd_water_pull_panel = read("godot_port/scripts/minigames/water_pull_panel.gd")
ts_water_entity = read("src/systems/waterMinigame/WaterEntity.ts")
gd_water_entity = read("godot_port/scripts/minigames/water_entity.gd")
ts_water_scene = read("src/systems/waterMinigame/WaterMinigameScene.ts")
gd_water_scene = read("godot_port/scripts/minigames/water_scene.gd")
ts_inventory_manager = read("src/systems/InventoryManager.ts")
gd_inventory_manager = read("godot_port/scripts/systems/inventory_manager.gd")
ts_rules_manager = read("src/systems/RulesManager.ts")
gd_rules_manager = read("godot_port/scripts/systems/rules_manager.gd")
ts_quest_manager = read("src/systems/QuestManager.ts")
gd_quest_manager = read("godot_port/scripts/systems/quest_manager.gd")
ts_encounter_manager = read("src/systems/EncounterManager.ts")
gd_encounter_manager = read("godot_port/scripts/systems/encounter_manager.gd")
ts_plane_reconciler = read("src/systems/PlaneReconciler.ts")
gd_plane_reconciler = read("godot_port/scripts/systems/plane_reconciler.gd")
gd_promise_observer = read("godot_port/scripts/runtime/promise_observer.gd")
ts_smell_system = read("src/systems/SmellSystem.ts")
gd_smell_system = read("godot_port/scripts/systems/smell_system.gd")
gd_pressure_hold_manager = read("godot_port/scripts/systems/pressure_hold_manager.gd")
gd_pressure_hold_ui = read("godot_port/scripts/ui/pressure_hold_ui.gd")
ts_dev_error_overlay = read("src/core/devErrorOverlay.ts")
gd_dev_error_overlay = read("godot_port/scripts/core/dev_error_overlay.gd")
ts_depth_log = read("src/core/depthLog.ts")
gd_depth_log = read("godot_port/scripts/core/depth_log.gd")
ts_debug_tools = read("src/core/DebugTools.ts")
gd_debug_tools = read("godot_port/scripts/core/debug_tools.gd")
ts_depth_debug_visualizer = read("src/debug/DepthDebugVisualizer.ts")
gd_depth_debug_visualizer = read("godot_port/scripts/debug/depth_debug_visualizer.gd")
gd_debug_panel = read("godot_port/scripts/ui/debug_panel_ui.gd")
ts_hud = read("src/ui/HUD.ts")
gd_hud = read("godot_port/scripts/ui/hud.gd")
ts_renderer = read("src/rendering/Renderer.ts")
gd_renderer = read("godot_port/scripts/rendering/renderer.gd")
gd_renderer_test = read("godot_port/tests/renderer_test.gd")
ts_camera = read("src/rendering/Camera.ts")
gd_camera = read("godot_port/scripts/rendering/camera.gd")
ts_background_debug_filter = read("src/rendering/BackgroundDebugFilter.ts")
gd_background_debug_filter = read("godot_port/scripts/rendering/background_debug_filter.gd")
gd_background_debug_shader = read("godot_port/scripts/rendering/background_debug_filter.gdshader")
ts_pixel_density_match = read("src/rendering/EntityPixelDensityMatch.ts")
gd_pixel_density_match = read("godot_port/scripts/rendering/entity_pixel_density_match.gd")
ts_sprite_entity = read("src/rendering/SpriteEntity.ts")
gd_sprite_entity = read("godot_port/scripts/rendering/sprite_entity.gd")
gd_sprite_entity_test = read("godot_port/tests/sprite_entity_test.gd")
gd_pixel_density_blur_shader = read("godot_port/scripts/rendering/pixel_density_blur.gdshader")
ts_filter_types = read("src/rendering/filter/types.ts")
gd_filter_types = read("godot_port/scripts/rendering/filter/types.gd")
ts_filter_loader = read("src/rendering/filter/FilterLoader.ts")
gd_filter_loader = read("godot_port/scripts/rendering/filter/filter_loader.gd")
ts_world_filter_pipeline = read("src/rendering/filter/WorldFilterPipeline.ts")
gd_world_filter_pipeline = read("godot_port/scripts/rendering/world_filter_pipeline.gd")
gd_world_filter_pipeline_test = read("godot_port/tests/world_filter_pipeline_test.gd")
ts_light_env = read("src/rendering/lightEnv.ts")
gd_light_env = read("godot_port/scripts/rendering/light_env_resolver.gd")
ts_light_env_curve = read("src/rendering/lightEnvCurve.ts")
gd_light_env_curve = read("godot_port/scripts/rendering/light_env_curve.gd")
ts_shadow_field = read("src/rendering/shadowField.ts")
gd_shadow_field = read("godot_port/scripts/rendering/uniform_shadow_field.gd")
ts_archive_manager = read("src/systems/ArchiveManager.ts")
gd_archive_manager = read("godot_port/scripts/systems/archive_manager.gd")
ts_bookshelf_ui = read("src/ui/BookshelfUI.ts")
gd_bookshelf_ui = read("godot_port/scripts/ui/bookshelf_ui.gd")
ts_character_book_ui = read("src/ui/CharacterBookUI.ts")
gd_character_book_ui = read("godot_port/scripts/ui/character_book_ui.gd")
ts_lore_book_ui = read("src/ui/LoreBookUI.ts")
gd_lore_book_ui = read("godot_port/scripts/ui/lore_book_ui.gd")
ts_document_box_ui = read("src/ui/DocumentBoxUI.ts")
gd_document_box_ui = read("godot_port/scripts/ui/document_box_ui.gd")
ts_book_reader_ui = read("src/ui/BookReaderUI.ts")
gd_book_reader_ui = read("godot_port/scripts/ui/book_reader_ui.gd")
ts_dev_mode_ui = read("src/ui/DevModeUI.ts")
gd_dev_mode_ui = read("godot_port/scripts/ui/dev_mode_ui.gd")
scene_manager = read("godot_port/scripts/systems/scene_manager.gd")
ts_scene_manager = read("src/systems/SceneManager.ts")
ts_zone_system = read("src/systems/ZoneSystem.ts")
gd_zone_system = read("godot_port/scripts/systems/zone_system.gd")
ts_zone_geometry = read("src/utils/zoneGeometry.ts")
gd_zone_geometry = read("godot_port/scripts/runtime/zone_geometry.gd")
ts_hotspot_collision = read("src/utils/hotspotCollision.ts")
gd_hotspot_collision = read("godot_port/scripts/utils/hotspot_collision.gd")
scene_depth = read("godot_port/scripts/systems/scene_depth_system.gd")
ts_scene_depth = read("src/core/SceneDepthSystem.ts")
scene_depth_filter_adapter = read("godot_port/scripts/rendering/scene_depth_filter_adapter.gd")
scene_entity_filter_binding = read("godot_port/scripts/rendering/scene_entity_filter_binding.gd")
cutscene_manager = read("godot_port/scripts/systems/cutscene_manager.gd")
ts_cutscene_manager = read("src/systems/CutsceneManager.ts")
ts_cutscene_renderer = read("src/rendering/CutsceneRenderer.ts")
gd_cutscene_renderer = read("godot_port/scripts/rendering/cutscene_renderer.gd")
ts_audio_manager = read("src/systems/AudioManager.ts")
gd_audio_manager = read("godot_port/scripts/systems/audio_manager.gd")
ts_emote_bubble_manager = read("src/systems/EmoteBubbleManager.ts")
gd_emote_bubble_manager = read("godot_port/scripts/systems/emote_bubble_manager.gd")
gd_audio_playback_handle = read("godot_port/scripts/runtime/audio_playback_handle.gd")
entity_runtime_field_schema = read("godot_port/scripts/runtime/entity_runtime_field_schema.gd")
ts_player = read("src/entities/Player.ts")
gd_player = read("godot_port/scripts/entities/player.gd")
ts_npc = read("src/entities/Npc.ts")
gd_npc = read("godot_port/scripts/entities/npc.gd")
ts_hotspot_entity = read("src/entities/Hotspot.ts")
gd_hotspot_entity = read("godot_port/scripts/entities/hotspot.gd")
ts_depth_occlusion_filter = read("src/rendering/DepthOcclusionFilter.ts")
gd_depth_occlusion_filter = read("godot_port/scripts/rendering/depth_occlusion_filter.gd")
gd_depth_occlusion_shader = read("godot_port/scripts/rendering/depth_occlusion.gdshader")
ts_entity_lighting_filter = read("src/rendering/EntityLightingFilter.ts")
gd_entity_lighting_filter = read("godot_port/scripts/rendering/entity_lighting_filter.gd")
gd_entity_lighting_shader = read("godot_port/scripts/rendering/entity_lighting_filter.gdshader")
gd_entity_shading_filters_test = read("godot_port/tests/entity_shading_filters_test.gd")
gd_graph_dialogue_manager = read("godot_port/scripts/systems/graph_dialogue_manager.gd")
ts_deterministic_random = read("src/utils/deterministicRandom.ts")
gd_deterministic_random = read("godot_port/scripts/utils/deterministic_random.gd")
ts_click_continue_prompt = read("src/ui/ClickContinuePrompt.ts")
gd_click_continue_prompt = read("godot_port/scripts/ui/click_continue_prompt.gd")
ts_scripted_dialogue_speaker = read("src/utils/scriptedDialogueSpeaker.ts")
gd_scripted_dialogue_speaker = read("godot_port/scripts/utils/scripted_dialogue_speaker.gd")
ts_animation_set_resolver = read("src/data/resolveAnimationSet.ts")
gd_animation_set_resolver = read("godot_port/scripts/utils/animation_set_resolver.gd")
ts_placeholder_factory = read("src/rendering/PlaceholderFactory.ts")
gd_placeholder_factory = read("godot_port/scripts/rendering/placeholder_factory.gd")
ts_asset_path = read("src/core/assetPath.ts")
gd_resource_locator = read("godot_port/scripts/runtime/resource_locator.gd")

utility_translations = CODE_TRANSLATION_CONTRACT.get("directUtilityTranslations", [])
require(utility_translations == [
    {
        "source": "src/utils/deterministicRandom.ts",
        "target": "godot_port/scripts/utils/deterministic_random.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/ClickContinuePrompt.ts",
        "target": "godot_port/scripts/ui/click_continue_prompt.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/utils/scriptedDialogueSpeaker.ts",
        "target": "godot_port/scripts/utils/scripted_dialogue_speaker.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/data/resolveAnimationSet.ts",
        "target": "godot_port/scripts/utils/animation_set_resolver.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/rendering/PlaceholderFactory.ts",
        "target": "godot_port/scripts/rendering/placeholder_factory.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/BookshelfUI.ts",
        "target": "godot_port/scripts/ui/bookshelf_ui.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/CharacterBookUI.ts",
        "target": "godot_port/scripts/ui/character_book_ui.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/LoreBookUI.ts",
        "target": "godot_port/scripts/ui/lore_book_ui.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/DocumentBoxUI.ts",
        "target": "godot_port/scripts/ui/document_box_ui.gd",
        "status": "verified-direct",
    },
    {
        "source": "src/ui/BookReaderUI.ts",
        "target": "godot_port/scripts/ui/book_reader_ui.gd",
        "status": "verified-direct",
    },
], "direct utility translation ledger drift")
require(ordered_tokens(ts_character_registry, [
    "export function buildCharacterRegistry(",
    "export function applyCharacterDefaults(",
    "export function portraitSlugFromAnimFile(",
]), "TypeScript characterRegistry module/function order drift")
require(ordered_tokens(gd_character_registry, [
    "static func build_character_registry(",
    "static func apply_character_defaults(",
    "static func portrait_slug_from_anim_file(",
]), "Godot characterRegistry module/function order drift")
require(ordered_tokens(gd_function(gd_character_registry, "build_character_registry"), [
    "var output: Dictionary = {}", "if characters is Array:",
    "for character: Variant in characters:", 'character.get("id", "")',
    "strip_edges()", "output[id] = character", "return output",
]), "Godot buildCharacterRegistry translation drift")
require(ordered_tokens(gd_function(gd_character_registry, "apply_character_defaults"), [
    'definition.get("characterId", "")', "strip_edges()", "if character_id.is_empty():",
    "return definition", "registry.get(character_id)", "if not character is Dictionary:",
    "return definition", "definition.duplicate(false)",
    'output.get("name")', 'character.get("name")', 'output["name"] = character["name"]',
    'output.get("animFile")', 'character.get("animFile")', 'output["animFile"] = character["animFile"]',
    'output.get("portraitSlug")', 'character.get("portraitSlug")', 'output["portraitSlug"] = character["portraitSlug"]',
    "return output",
]), "Godot applyCharacterDefaults precedence/copy translation drift")
require(ordered_tokens(gd_function(gd_character_registry, "portrait_slug_from_anim_file"), [
    "if not _is_js_truthy(anim_file):", "return null",
    'regex.compile("/animation/([^/]+)/anim\\\\.json")', "regex.search(str(anim_file))",
    "matched.get_string(1) if matched != null else null",
]), "Godot portraitSlugFromAnimFile null/regex translation drift")
require('RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")' in bootstrap and
        "RuntimeCharacterRegistryScript.build_character_registry(raw.get(\"characters\") if raw is Dictionary else null)" in bootstrap,
        "Godot Game.loadCharacterRegistry does not delegate through the source module boundary")
require('RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")' in scene_manager and
        scene_manager.count("RuntimeCharacterRegistryScript.apply_character_defaults(") == 2,
        "Godot SceneManager does not preserve both character-default call sites")
require('RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")' in gd_npc and
        "RuntimeCharacterRegistryScript.portrait_slug_from_anim_file(" in gd_npc,
        "Godot Npc does not delegate portrait-slug inference through characterRegistry")
for flattened_character_registry_method in [
    "static func build_character_registry(", "static func apply_character_defaults(",
    "static func portrait_slug_from_anim_file(",
]:
    require(flattened_character_registry_method not in gd_npc,
            f"Godot Npc still owns flattened characterRegistry logic: {flattened_character_registry_method}")
require(ordered_tokens(ts_data_types, [
    "export enum GameState", "export function entityCutsceneIds(",
    "export function isEntityBoundToCutscene(", "export function hasCutsceneBinding(",
    "export function isCutsceneOnlyEntity(", "export function isSharedCutsceneEntity(",
    "export enum QuestStatus", "export const CUTSCENE_ACTION_WHITELIST",
    "export const CUTSCENE_ANON_SHOT_ID",
]), "TypeScript data/types runtime declaration order drift")
require(ordered_tokens(gd_data_types, [
    'const MAIN_MENU := "MainMenu"', 'const EXPLORING := "Exploring"',
    'const ACTION_SEQUENCE := "ActionSequence"', 'const DIALOGUE := "Dialogue"',
    'const ENCOUNTER := "Encounter"', 'const CUTSCENE := "Cutscene"',
    'const UI_OVERLAY := "UIOverlay"', 'const MINIGAME := "Minigame"',
    "static func entity_cutscene_ids(", "static func is_entity_bound_to_cutscene(",
    "static func has_cutscene_binding(", "static func is_cutscene_only_entity(",
    "static func is_shared_cutscene_entity(", "const QUEST_INACTIVE := 0",
    "const QUEST_ACTIVE := 1", "const QUEST_COMPLETED := 2",
    "const CUTSCENE_ACTION_WHITELIST := [", 'const CUTSCENE_ANON_SHOT_ID := "__anonShot"',
]), "Godot data/types runtime declaration/order drift")
require(ordered_tokens(gd_function(gd_data_types, "entity_cutscene_ids"), [
    "var output: Array[String] = []", 'definition.get("cutsceneIds")', "if raw_ids is Array:",
    "for raw: Variant in raw_ids:", 'raw.strip_edges() if raw is String else ""',
    "not id.is_empty() and not output.has(id)", "output.push_back(id)", "return output",
]), "Godot entityCutsceneIds filter/trim/deduplicate translation drift")
require(ordered_tokens(gd_function(gd_data_types, "is_entity_bound_to_cutscene"), [
    'active_id.strip_edges() if active_id is String else ""',
    "not id.is_empty() and entity_cutscene_ids(definition).has(id)",
]), "Godot isEntityBoundToCutscene translation drift")
require(ordered_tokens(gd_function(gd_data_types, "has_cutscene_binding"), [
    "not entity_cutscene_ids(definition).is_empty()",
]), "Godot hasCutsceneBinding translation drift")
require(ordered_tokens(gd_function(gd_data_types, "is_cutscene_only_entity"), [
    'definition.get("cutsceneOnly")', "has_cutscene_binding(definition)",
    "not (cutscene_only is bool and cutscene_only == false)",
]), "Godot isCutsceneOnlyEntity strict-false translation drift")
require(ordered_tokens(gd_function(gd_data_types, "is_shared_cutscene_entity"), [
    'definition.get("cutsceneOnly")', "has_cutscene_binding(definition)",
    "cutscene_only is bool and cutscene_only == false",
]), "Godot isSharedCutsceneEntity strict-false translation drift")
source_cutscene_action_allowlist = json.loads(read("src/data/cutscene_action_allowlist.json"))
gd_cutscene_action_allowlist = re.findall(
    r'"([^"]+)"',
    section(gd_data_types, "const CUTSCENE_ACTION_WHITELIST := [", "const CUTSCENE_ANON_SHOT_ID"),
)
require(gd_cutscene_action_allowlist == source_cutscene_action_allowlist,
        "Godot CUTSCENE_ACTION_WHITELIST differs from the source JSON import")
require(not (ROOT / "godot_port/scripts/runtime/scene_entity_binding.gd").exists(),
        "Godot retains a fabricated scene-entity-binding module outside data/types")
require("RuntimeSceneEntityBinding" not in scene_manager and
        "RuntimeDataTypes.is_cutscene_only_entity(" in scene_manager and
        "RuntimeDataTypes.is_entity_bound_to_cutscene(" in scene_manager,
        "Godot SceneManager does not import cutscene-binding helpers from data/types")
require("const MAIN_MENU" not in gd_game_state_controller and "const EXPLORING" not in gd_game_state_controller,
        "Godot GameStateController still owns the data/types GameState enum")
require("const QUEST_INACTIVE" not in gd_quest_manager and "const QUEST_ACTIVE" not in gd_quest_manager and
        "const QUEST_COMPLETED" not in gd_quest_manager and "RuntimeDataTypes.QUEST_INACTIVE" in gd_quest_manager,
        "Godot QuestManager still owns the data/types QuestStatus enum")
require("const RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST" not in cutscene_manager and
        "RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST" in cutscene_manager,
        "Godot CutsceneManager still owns the data/types cutscene action whitelist")
require("const ANON_SHOT_ID" not in gd_cutscene_renderer and
        "RuntimeDataTypes.CUTSCENE_ANON_SHOT_ID" in gd_cutscene_renderer and
        "RuntimeDataTypes.CUTSCENE_ANON_SHOT_ID" in cutscene_manager,
        "Godot cutscene modules still own the data/types anonymous-shot ID")
for path in (ROOT / "godot_port/scripts").rglob("*.gd"):
    content = path.read_text(encoding="utf-8")
    if path.name != "data_types.gd" and "RuntimeDataTypes." in content:
        require('const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")' in content,
                f"Godot runtime module uses data/types without an explicit dependency: {path.relative_to(ROOT)}")
require(ordered_tokens(ts_hotspot_collision, [
    "export function anchorCollisionPolygonToWorld(",
    "export function hotspotCollisionPolygonToWorld(",
    "export function npcCollisionPolygonToWorld(",
]), "TypeScript hotspotCollision module/function order drift")
require(ordered_tokens(gd_hotspot_collision, [
    "static func anchor_collision_polygon_to_world(",
    "static func hotspot_collision_polygon_to_world(",
    "static func npc_collision_polygon_to_world(",
]), "Godot hotspotCollision module/function order drift")
require(ordered_tokens(gd_function(gd_hotspot_collision, "anchor_collision_polygon_to_world"), [
    'definition.get("collisionPolygon")', "polygon == null or not RuntimeZoneGeometryScript.is_valid_zone_polygon(polygon)",
    "return null", 'definition.get("collisionPolygonLocal")',
    "local_value is bool and local_value == true", "if not is_local:",
    'output.push_back({"x": point.x, "y": point.y})', "return output",
    'output.push_back({"x": point.x + anchor_x, "y": point.y + anchor_y})', "return output",
]), "Godot anchorCollisionPolygonToWorld validation/copy/strict-local translation drift")
require(ordered_tokens(gd_function(gd_hotspot_collision, "hotspot_collision_polygon_to_world"), [
    "anchor_collision_polygon_to_world(definition.x, definition.y, definition)",
]), "Godot hotspotCollisionPolygonToWorld wrapper drift")
require(ordered_tokens(gd_function(gd_hotspot_collision, "npc_collision_polygon_to_world"), [
    "anchor_collision_polygon_to_world(npc.get_x(), npc.get_y(), npc.def)",
]), "Godot npcCollisionPolygonToWorld runtime-anchor wrapper drift")
require('RuntimeHotspotCollisionScript := preload("res://scripts/utils/hotspot_collision.gd")' in gd_hotspot_entity and
        "RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(def)" in gd_hotspot_entity,
        "Godot Hotspot does not delegate occlusion polygon conversion through hotspotCollision")
require("static func collision_polygon_to_world(" not in gd_hotspot_entity and
        "static func _is_valid_polygon(" not in gd_hotspot_entity,
        "Godot Hotspot still owns flattened hotspotCollision/zoneGeometry logic")
require('RuntimeHotspotCollisionScript := preload("res://scripts/utils/hotspot_collision.gd")' in bootstrap,
        "Godot Game does not import the hotspotCollision module")
require(ordered_tokens(ts_renderer, [
    "public app:", "public worldContainer:", "public backgroundLayer:", "public shadowLayer:",
    "public entityLayer:", "public cutsceneOverlay:", "public uiLayer:",
    "public worldFilterPipeline:", "private assetManager:", "private initialized", "private tornDown",
    "private mountObserver:", "private afterResizeCallbacks", "private viewportWidth", "private viewportHeight",
    "constructor()", "setAssetManager(", "async init(", "subscribeAfterResize(", "private notifyAfterResize(",
    "setViewportSize(", "getViewportSize(", "setWindowSize(", "sortEntityLayer(", "get screenWidth(",
    "get screenHeight(", "isInitialized(", "destroy(", "setWorldFilters(", "setWorldFilter(",
    "async loadAndSetWorldFilter(", "clearWorldFilter(", "getDebugRenderState(",
]), "TypeScript Renderer field/method architecture drift")
require(ordered_tokens(gd_renderer, [
    "var app:", "var world_container:", "var background_layer:", "var shadow_layer:", "var entity_layer:",
    "var cutscene_overlay:", "var ui_layer:", "var world_filter_pipeline:", "var _asset_manager:",
    "var _initialized", "var _torn_down", "var _after_resize_callbacks", "var _viewport_width",
    "var _viewport_height", "var screen_width:", "var screen_height:", "func _init(",
    "func set_asset_manager(", "func init(", "func subscribe_after_resize(", "func _notify_after_resize(",
    "func set_viewport_size(", "func get_viewport_size(", "func set_window_size(",
    "func sort_entity_layer(", "func is_initialized(", "func destroy(", "func set_world_filters(",
    "func set_world_filter(", "func load_and_set_world_filter(", "func clear_world_filter(",
    "func get_debug_render_state(",
]), "Godot Renderer field/method architecture drift")
require(ordered_tokens(gd_function(gd_renderer, "_init"), [
    "app = self", "world_container = CanvasGroup.new()", 'world_container.name = "WorldContainer"',
    "background_layer = Node2D.new()", 'background_layer.name = "BackgroundLayer"',
    "shadow_layer = Node2D.new()", 'shadow_layer.name = "ShadowLayer"',
    "entity_layer = Node2D.new()", 'entity_layer.name = "EntityLayer"',
    "cutscene_overlay = CanvasLayer.new()", 'cutscene_overlay.name = "CutsceneOverlay"',
    "ui_layer = CanvasLayer.new()", 'ui_layer.name = "UILayer"',
    "world_filter_pipeline = RuntimeWorldFilterPipeline.new(world_container)",
]), "Godot Renderer constructor graph/ownership drift")
require(ordered_tokens(gd_function(gd_renderer, "init"), [
    'options.get("resolution")', "is_finite(float(requested_resolution))", "RenderingServer.set_default_clear_color",
    "world_container.add_child(background_layer)", "world_container.add_child(shadow_layer)",
    "world_container.add_child(entity_layer)", "add_child(world_container)", "add_child(cutscene_overlay)",
    "add_child(ui_layer)", "_initialized = true",
]), "Godot Renderer init options/layer-mount order drift")
require(ordered_tokens(gd_function(gd_renderer, "subscribe_after_resize"), [
    "callback.is_valid()", "not _after_resize_callbacks.has(callback)",
    "_after_resize_callbacks.push_back(callback)", "return func() -> void:",
    "_after_resize_callbacks.erase(callback)",
]), "Godot Renderer resize subscription/identity/unsubscribe drift")
require(ordered_tokens(gd_function(gd_renderer, "set_viewport_size"), [
    "_viewport_width = width", "_viewport_height = height", "get_tree().root.content_scale_size",
    "width > 0 and height > 0", "else Vector2i.ZERO", "_notify_after_resize()",
]), "Godot Renderer logical viewport/resize notification drift")
require(ordered_tokens(gd_function(gd_renderer, "get_viewport_size"), [
    "_viewport_width > 0 and _viewport_height > 0", 'return {"width": _viewport_width, "height": _viewport_height}',
    "return null",
]), "Godot Renderer getViewportSize null/object contract drift")
require(ordered_tokens(gd_function(gd_renderer, "sort_entity_layer"), [
    "var has_player", 'node.get_meta("entitySortBand")', 'node.get_meta("entityOcclusionPolygon")',
    "polygon is Array and polygon.size() >= 3", "RuntimeZoneGeometry.point_polygon_vertical_side(",
    'side == "below"', 'band = "back"', 'side == "above" or side == "inside"', 'band = "front"',
    "node.position.y", "node.z_index =",
]), "Godot Renderer entity y/band/polygon sort translation drift")
require("global_position.y" not in gd_function(gd_renderer, "sort_entity_layer"),
        "Godot Renderer sorts by transformed global y instead of source child.y")
require(ordered_tokens(gd_function(gd_renderer, "destroy"), [
    "if _torn_down:", "return", "_torn_down = true", "_initialized = false",
    "_after_resize_callbacks.clear()", "world_filter_pipeline.clear()",
]), "Godot Renderer teardown guard/state/callback/filter ownership drift")
require(ordered_tokens(gd_function(gd_renderer, "set_world_filters"), [
    "world_filter_pipeline.set_filters(filters)",
]) and "duplicate" not in gd_function(gd_renderer, "set_world_filters"),
        "Godot Renderer setWorldFilters changes caller array identity")
require(ordered_tokens(gd_function(gd_renderer, "set_world_filter"), [
    "world_filter_pipeline.set_filters([filter] if filter != null else [])",
]), "Godot Renderer setWorldFilter singleton/clear translation drift")
require(ordered_tokens(gd_function(gd_renderer, "load_and_set_world_filter"), [
    "_asset_manager.load_filter(filter_id)", "RuntimeFilterLoaderScript.load_filter(filter_id)",
    "if not filter is Material:", "return false", "set_world_filter(filter)", "return true",
]), "Godot Renderer loadAndSetWorldFilter asset-manager/fallback/apply adapter drift")
require(ordered_tokens(gd_function(gd_renderer, "get_debug_render_state"), [
    "world_container.position - RuntimeCamera.RASTER_PHASE", '"worldX": logical_position.x',
    '"worldY": logical_position.y', '"worldScaleX": world_container.scale.x',
    '"worldScaleY": world_container.scale.y', "world_filter_pipeline.get_filters().size()",
    "world_filter_pipeline.has_filters()",
]), "Godot Renderer debug-state/pipeline/raster adapter drift")
require(all(token not in gd_renderer for token in [
    "init_renderer", "destroy_renderer", "get_screen_width", "get_screen_height", "get_world_filters",
    "get_window_size_request", "\nvar _world_filters", "\nvar _window_width", "\nvar _window_height",
]), "Godot Renderer retains target-only compatibility API/state")
require(ordered_tokens(gd_renderer_test, [
    "renderer.init()", "renderer.app == renderer", '== ["WorldContainer", "CutsceneOverlay", "UILayer"]',
    '== ["BackgroundLayer", "ShadowLayer", "EntityLayer"]', "renderer.subscribe_after_resize(",
    "renderer.set_viewport_size(640, 360)", '== {"width": 640, "height": 360}',
    "renderer.screen_width == 640", "renderer.sort_entity_layer()", "entityOcclusionPolygon",
    "renderer.set_world_filters(", "renderer.world_filter_pipeline.get_filters()",
    "renderer.clear_world_filter()", "renderer.destroy()", "not renderer.is_initialized()",
]), "Renderer regression test lost graph/resize/sort/filter/teardown coverage")
require('("res://tests/renderer_test.tscn", "Renderer layer/resize lifecycle test: PASS")' in run_tests,
        "Renderer regression test is not registered in the mandatory Godot suite")
require(ordered_tokens(ts_camera, [
    "private worldContainer", "private pixelsPerUnit", "private zoom", "private worldScale",
    "private targetX", "private targetY", "private currentX", "private currentY", "private smoothing",
    "private boundsWidth", "private boundsHeight", "private screenWidth", "private screenHeight",
    "private pixelSnapTranslation", "private pixelSnapLastProjectionScale", "constructor(",
    "setScreenSize(", "setBounds(", "setPixelsPerUnit(", "setZoom(", "setWorldScale(",
    "follow(", "snapTo(", "update(", "getX(", "getY(", "getZoom(", "getWorldScale(",
    "getPixelsPerUnit(", "getProjectionScale(", "setPixelSnapTranslation(", "getViewWidth(",
    "getViewHeight(", "screenToWorld(", "private clampCenterWorld(",
    "private syncBoundsIntoState(", "private applyTransform(",
]), "TypeScript Camera field/method order drift")
require(ordered_tokens(gd_camera, [
    "var _world_container", "var _pixels_per_unit", "var _zoom", "var _world_scale",
    "var _target_x", "var _target_y", "var _current_x", "var _current_y", "var _smoothing",
    "var _bounds_width", "var _bounds_height", "var _screen_width", "var _screen_height",
    "var _pixel_snap_translation", "var _pixel_snap_last_projection_scale", "func _init(",
    "func set_screen_size(", "func set_bounds(", "func set_pixels_per_unit(", "func set_zoom(",
    "func set_world_scale(", "func follow(", "func snap_to(", "func update(", "func get_x(",
    "func get_y(", "func get_zoom(", "func get_world_scale(", "func get_pixels_per_unit(",
    "func get_projection_scale(", "func set_pixel_snap_translation(", "func get_view_width(",
    "func get_view_height(", "func screen_to_world(", "func _clamp_center_world(",
    "func _sync_bounds_into_state(", "func _apply_transform(",
]), "Godot Camera field/method order drift")
require("var _target := Vector2" not in gd_camera and "var _current := Vector2" not in gd_camera and
        "var _bounds := Vector2" not in gd_camera and "var _screen := Vector2" not in gd_camera,
        "Godot Camera compresses source-owned scalar fields into a different state architecture")
require(ordered_tokens(gd_function(gd_camera, "update"), [
    "minf(1.0, maxf(0.0, _smoothing))", "var reference_fps := 60.0",
    "1.0 - pow(1.0 - base, delta_time * reference_fps)",
    "_current_x += (_target_x - _current_x) * alpha", "_current_y += (_target_y - _current_y) * alpha",
    "_clamp_center_world(_current_x, _current_y)", "_apply_transform()",
]), "Godot Camera frame-rate-independent follow drift")
require(ordered_tokens(gd_function(gd_camera, "_clamp_center_world"), [
    "_bounds_width <= 0.0 or _bounds_height <= 0.0", "return Vector2(x, y)",
    "_screen_width / projection_scale", "_screen_height / projection_scale",
    "if maximum_x < minimum_x:", "_bounds_width / 2.0", "if maximum_y < minimum_y:",
    "_bounds_height / 2.0", "maxf(minimum_x, minf(x, maximum_x))", "maxf(minimum_y, minf(y, maximum_y))",
]), "Godot Camera center clamp/oversized-view drift")
require(ordered_tokens(gd_function(gd_camera, "_apply_transform"), [
    "get_projection_scale()", "_current_x", "_current_y",
    "_world_container.scale = Vector2(projection_scale, projection_scale)",
    "-camera_x * projection_scale + _screen_width / 2.0", "-camera_y * projection_scale + _screen_height / 2.0",
    "previous != null and absf(projection_scale - float(previous)) < 0.00001",
    "floorf(translation_x + 0.5)", "floorf(translation_y + 0.5)",
    "_pixel_snap_last_projection_scale = projection_scale", "_pixel_snap_last_projection_scale = null",
    "Vector2(translation_x, translation_y) + RASTER_PHASE",
]), "Godot Camera view-projection/pixel-snap/raster adapter drift")
require(ordered_tokens(gd_function(gd_camera, "screen_to_world"), [
    "_world_container.position - RASTER_PHASE", "(screen_x - logical_translation.x) / projection_scale",
    "(screen_y - logical_translation.y) / projection_scale",
]), "Godot Camera screenToWorld does not cancel its raster-phase adapter")
require(ordered_tokens(ts_background_debug_filter, [
    "let sharedProgram", "function getProgram(", "export function warmUpBackgroundDebugGlProgramForDiagnostics(",
    "export class BackgroundDebugFilter", "constructor()", "private get _u", "setMode(", "getMode(",
    "loadSceneData(", "setWorldContainerPos(", "setSceneSize(", "setCollisionTexture(",
]), "TypeScript BackgroundDebugFilter architecture/method order drift")
require(ordered_tokens(gd_background_debug_filter, [
    "const SHADER := preload", "var material := ShaderMaterial.new()",
    "static func warm_up_background_debug_gl_program_for_diagnostics(", "func _init(",
    "func set_mode(", "func get_mode(", "func load_scene_data(",
    "func set_world_container_pos(", "func set_scene_size(", "func set_collision_texture(",
]), "Godot BackgroundDebugFilter architecture/method order drift")
gd_background_load = gd_function(gd_background_debug_filter, "load_scene_data")
require(ordered_tokens(gd_background_load, [
    'set_shader_parameter("depth_map", depth_texture)', 'set_shader_parameter("texture_size", Vector2(texture_width, texture_height))',
    'config.depth_mapping', '"depth_invert"', '"depth_scale"', '"depth_offset"',
    "minf(offset, scale + offset)", "maxf(offset, scale + offset)", "if low > high:",
    "span * 0.12", "maxf(absf(scale), 0.000001) * 0.05", "0.001",
    "if span < 0.00000001:", "offset - 1.0", "offset + 1.0",
    "if normalized_high - normalized_low < 0.000001:", "normalized_low -= 1.0", "normalized_high += 1.0",
    '"debug_depth_range"', "var matrix: Dictionary = config.M", '"matrix_ppu"', '"matrix_cx"', '"matrix_cy"',
    '"matrix_r00"', '"matrix_r01"', '"matrix_r02"', '"matrix_r20"', '"matrix_r21"', '"matrix_r22"',
    '"floor_a"', '"floor_b"', 'config.get("collision")', '"collision_x_min"', '"collision_z_min"',
    '"collision_cell_size"', '"collision_grid_width"', '"collision_grid_height"',
]), "Godot BackgroundDebugFilter depth-range/matrix/collision uniform translation drift")
require(ordered_tokens(gd_background_debug_shader, [
    "uniform sampler2D depth_map", "uniform sampler2D collision_map", "uniform float mode", "uniform vec2 texture_size",
    "uniform vec2 world_container_pos", "uniform vec2 scene_size", "uniform float depth_invert",
    "uniform float depth_scale", "uniform float depth_offset", "uniform float matrix_ppu",
    "uniform float matrix_r00", "uniform float matrix_r20", "uniform float floor_a", "uniform float floor_b",
    "uniform float collision_x_min", "uniform float collision_z_min", "uniform float collision_cell_size",
    "uniform float collision_grid_width", "uniform float collision_grid_height", "uniform vec2 debug_depth_range",
    "float asinh_fast(", "vec3 depth_debug_colormap(", "void fragment()", "FRAGCOORD.x - world_container_pos.x",
    "FRAGCOORD.y - world_container_pos.y", "screen_x / scene_size.x", "screen_y / scene_size.y",
    "raw_depth", "depth_invert > 0.5", "mapped * depth_scale + depth_offset", "asinh_fast(depth)",
    "texture_x", "texture_y", "floor_a * texture_y + floor_b", "matrix_r00 * projected_x",
    "matrix_r20 * projected_x", "(world_x - collision_x_min) / collision_cell_size",
    "grid_x / collision_grid_width", "texture(collision_map, collision_uv).r > 0.5",
]), "Godot BackgroundDebugFilter shader lost source depth/collision/UV projection stages")
gd_depth_debug_visualizer = read("godot_port/scripts/debug/depth_debug_visualizer.gd")
require(ordered_tokens(gd_function(gd_depth_debug_visualizer, "update"), [
    'if _current_mode == "off":', "_renderer.world_container.position - RuntimeCamera.RASTER_PHASE",
    "_filter.set_world_container_pos(", "_camera.get_projection_scale()",
    "_filter.set_scene_size(_scene_w * projection_scale, _scene_h * projection_scale)",
]), "Godot DepthDebugVisualizer does not feed BackgroundDebugFilter source-coordinate uniforms")
require(ordered_tokens(ts_pixel_density_match, [
    "export const DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE", "export function computePixelDensityK(",
    "const BLUR_STRENGTH_CAP", "export function blurStrengthFromPixelDensityK(",
    "export function createPixelDensityBlurFilter(",
]), "TypeScript EntityPixelDensityMatch declaration/function order drift")
require(ordered_tokens(gd_pixel_density_match, [
    "const DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE", "static func compute_pixel_density_k(",
    "const BLUR_STRENGTH_CAP", "static func blur_strength_from_pixel_density_k(",
    "static func create_pixel_density_blur_filter(", "class _BlurFilterAdapter",
]), "Godot EntityPixelDensityMatch declaration/function order drift")
require(ordered_tokens(gd_function(gd_pixel_density_match, "compute_pixel_density_k"), [
    "world_width <= 0.0 or world_height <= 0.0 or background_density.x <= 0.0 or background_density.y <= 0.0",
    "return 1.0", "frame_width / world_width", "frame_height / world_height",
    "entity_density_x / background_density.x", "entity_density_y / background_density.y",
    "maxf(1.0, maxf(density_ratio_x, density_ratio_y))",
]), "Godot computePixelDensityK formula/guard drift")
require(ordered_tokens(gd_function(gd_pixel_density_match, "blur_strength_from_pixel_density_k"), [
    "if density_k <= 1.0:", "return 0.0", "is_finite(strength_scale) and strength_scale > 0.0",
    "else 1.0", "density_k - 1.0", "var curve_constant := 0.18",
    "curve_constant * sqrt(excess) * scale", "minf(BLUR_STRENGTH_CAP, strength)",
]), "Godot blurStrengthFromPixelDensityK curve/scale/cap drift")
require(ordered_tokens(gd_function(gd_pixel_density_match, "create_pixel_density_blur_filter"), [
    "maxf(0.0, initial_strength)", "_BlurFilterAdapter.new(strength, PIXEL_DENSITY_BLUR_SHADER)",
]), "Godot createPixelDensityBlurFilter strength clamp/adapter drift")
require("var quality := 3" in gd_pixel_density_match and "func destroy()" in gd_pixel_density_match,
        "Godot pixel-density BlurFilter engine adapter lacks source quality/lifecycle surface")
require("blur_radius_texels" not in gd_pixel_density_match and "texture_frame_size" not in gd_pixel_density_match,
        "Godot EntityPixelDensityMatch owns fabricated engine-composition helpers")
require("static func _blur_radius_texels(" in scene_entity_filter_binding and
        "static func _texture_frame_size(" in scene_entity_filter_binding,
        "Godot combined scene-filter engine adapter lost its private pixel-density conversion helpers")
require(ordered_tokens(ts_sprite_entity, [
    "public container:", "public x:", "public y:", "private sprite:", "private baseTexture:",
    "private animDef:", "private frames:", "private facingX:", "get facingDirection",
    "private worldWidth:", "private worldHeight:", "private currentState:", "private currentFrames:",
    "private currentFrameDef:", "private frameIndex:", "private frameTimer:", "private playing:",
    "private onCompleteCallback:", "private logicalToClip:", "private pixelDensityBlur:",
    "private pixelDensityMatchActive", "private pixelDensityBlurMounted", "constructor()",
    "loadFromDef(", "private disposeFrameTextures(", "destroy(", "setLogicalStateMap(",
    "private resolveClip(", "playAnimation(", "setDirection(", "update(", "private syncPosition(",
    "getCurrentState(", "getFrameCount(", "getFrameIndex(", "getDebugVisualState(",
    "resetAnimationClock(", "setFrameIndex(", "setPlaying(", "getStateNames(", "getWorldSize(",
    "getDisplayTexture(", "setPixelDensityMatchActive(", "getPixelDensityMatchActive(",
    "applyPixelDensityMatch(", "private unmountPixelDensityBlur(", "private clearPixelDensityBlur(",
    "private getCurrentFramePixelSize(", "private applySpriteScale(",
]), "TypeScript SpriteEntity field/method architecture drift")
require(ordered_tokens(gd_sprite_entity, [
    "extends Node2D", "var container:", "var x", "var y", "var sprite:", "var _base_texture:",
    "var _anim_def:", "var _frames:", "var _facing_x", "var _world_width", "var _world_height",
    "var _current_state", "var _current_frames", "var _current_frame_def", "var _frame_index",
    "var _frame_timer", "var _playing", "var _on_complete_callback", "var _logical_to_clip",
    "var _pixel_density_blur:", "var _pixel_density_match_active", "var _pixel_density_blur_mounted",
    "func _init(", "func load_from_def(", "func _dispose_frame_textures(", "func destroy(",
    "func set_logical_state_map(", "func _resolve_clip(", "func play_animation(", "func set_direction(",
    "func update(", "func _sync_position(", "func get_current_state(", "func get_frame_count(",
    "func get_frame_index(", "func get_debug_visual_state(", "func reset_animation_clock(",
    "func set_frame_index(", "func set_playing(", "func get_state_names(", "func get_world_size(",
    "func get_display_texture(", "func get_facing_direction(", "func set_pixel_density_match_active(",
    "func get_pixel_density_match_active(", "func apply_pixel_density_match(",
    "func _unmount_pixel_density_blur(", "func _clear_pixel_density_blur(",
    "func _get_current_frame_pixel_size(", "func _apply_sprite_scale(",
]), "Godot SpriteEntity field/method architecture drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_init"), [
    "container = self", "sprite = Sprite2D.new()", "sprite.centered = true", "add_child(sprite)",
]), "Godot SpriteEntity container/child-anchor construction drift")
gd_sprite_load = gd_function(gd_sprite_entity, "load_from_def")
require(ordered_tokens(gd_sprite_load, [
    "_dispose_frame_textures()", "_base_texture = texture", "_anim_def = animation_def",
    "_world_width = float(animation_def.worldWidth)", "_world_height = float(animation_def.worldHeight)",
    "int(animation_def.cols)", "int(animation_def.rows)", 'animation_def.get("cellWidth")',
    'animation_def.get("cellHeight")', "float(raw_cell_width) > 0.0", "float(texture.get_width()) / cols",
    "float(raw_cell_height) > 0.0", "float(texture.get_height()) / rows",
    "for state_name: String in animation_def.states:", "for raw_frame_index: Variant in state_definition.frames:",
    "frame_index % cols", "floori(float(frame_index) / cols)", 'animation_def.get("atlasFrames")',
    "float(box.get(\"width\", 0.0)) > 0.0", "float(box.get(\"height\", 0.0)) > 0.0",
    "AtlasTexture.new()", "frame_texture.atlas = texture", "frame_texture.region = Rect2(",
    "_frames[state_name] = textures", "_apply_sprite_scale()",
]) and "animation_def.duplicate" not in gd_sprite_load and "maxi(1" not in gd_sprite_load,
        "Godot SpriteEntity loadFromDef identity/stride/atlas slicing drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_dispose_frame_textures"), [
    "sprite.texture = null", "_frames.clear()", "_current_frames = []", "_current_frame_def = null",
    "_frame_index = 0", "_frame_timer = 0.0", "_playing = false", "_on_complete_callback = null",
    '_current_state = ""',
]), "Godot SpriteEntity frame-texture/cursor disposal drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "destroy"), [
    "_clear_pixel_density_blur()", "_dispose_frame_textures()", "_base_texture = null",
    "_anim_def = {}", "_logical_to_clip.clear()", "material = null", "sprite.free()", "sprite = null",
]), "Godot SpriteEntity destroy ownership/order drift")
require(all(token not in gd_sprite_entity for token in ["func load_from_paths(", "func destroy_entity("]),
        "Godot SpriteEntity retains target-only loading/lifecycle compatibility methods")
require(ordered_tokens(gd_function(gd_sprite_entity, "set_logical_state_map"), [
    "_logical_to_clip.clear()", "if not map is Dictionary:", "return", "for logical: Variant in map:",
    "not str(logical).is_empty()", "not str(clip).is_empty()", "_logical_to_clip[str(logical)] = str(clip)",
]), "Godot SpriteEntity logical-state map translation drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "play_animation"), [
    "_resolve_clip(state_name)", "_current_state == clip and _playing", "return",
    '_anim_def.get("states", {}).get(clip)', "_frames.get(clip)", "textures.is_empty()", "return",
    "_current_state = clip", "_current_frames = textures", "_current_frame_def = frame_definition",
    "_frame_index = 0", "_frame_timer = 0.0", "_playing = true",
    "_on_complete_callback = on_complete", "sprite.texture = textures[0]",
]) and "_apply_sprite_scale()" not in gd_function(gd_sprite_entity, "play_animation"),
        "Godot SpriteEntity playAnimation idempotence/selection/start-frame drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "update"), [
    "not _playing or not _current_frame_def is Dictionary or _current_frames.size() <= 1",
    "_sync_position()", "return", "_frame_timer += dt", '_current_frame_def.get("frameRate")',
    "is_finite(float(raw_frame_rate))", "else 8.0", "1.0 / frame_rate",
    "while _frame_timer >= frame_duration:", "_frame_timer -= frame_duration", "_frame_index += 1",
    "_frame_index >= _current_frames.size()", '_current_frame_def.get("loop") == true',
    "_frame_index = 0", "_frame_index = _current_frames.size() - 1", "_playing = false",
    "_on_complete_callback.call()", "break", "sprite.texture = _current_frames[_frame_index]",
    "_apply_sprite_scale()", "_sync_position()",
]), "Godot SpriteEntity frame clock/loop/completion/position translation drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "set_frame_index"), [
    "if _current_frames.is_empty():", "return", "posmod(index, count)", "_frame_timer = 0.0",
    "sprite.texture = _current_frames[_frame_index]", "_apply_sprite_scale()", "_sync_position()",
]), "Godot SpriteEntity preview scrub/modulo translation drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "set_pixel_density_match_active"), [
    "_pixel_density_match_active == active", "return", "_pixel_density_match_active = active",
    'sprite.set_meta("roundPixels", active)', "if not active:", "_clear_pixel_density_blur()",
]), "Godot SpriteEntity pixel-density activation/boundary teardown drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "apply_pixel_density_match"), [
    "if not _pixel_density_match_active:", "return", "_base_texture == null or _anim_def.is_empty()",
    "_clear_pixel_density_blur()", "_get_current_frame_pixel_size()",
    "RuntimeEntityPixelDensityMatch.compute_pixel_density_k(",
    "RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(", "if strength <= 0.0:",
    "_unmount_pixel_density_blur()", "return", "if _pixel_density_blur == null:",
    "RuntimeEntityPixelDensityMatch.create_pixel_density_blur_filter(strength)",
    "_pixel_density_blur.strength = strength", "if not _pixel_density_blur_mounted:",
    "sprite.material = _pixel_density_blur.material", "_pixel_density_blur_mounted = true",
]), "Godot SpriteEntity density-k/blur reuse/mount translation drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_unmount_pixel_density_blur"), [
    "if not _pixel_density_blur_mounted:", "return", "sprite.material == _pixel_density_blur.material",
    "sprite.material = null", "_pixel_density_blur_mounted = false",
]), "Godot SpriteEntity blur unmount/reuse drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_clear_pixel_density_blur"), [
    "_unmount_pixel_density_blur()", "_pixel_density_blur.destroy()", "_pixel_density_blur = null",
]), "Godot SpriteEntity blur destruction drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_get_current_frame_pixel_size"), [
    "_base_texture == null or _anim_def.is_empty()", "return Vector2.ONE", "int(_anim_def.cols)",
    "int(_anim_def.rows)", 'raw_cell_width', 'raw_cell_height', "frame_width := stride_width",
    "frame_height := stride_height", '_anim_def.get("atlasFrames")', "_frame_index % sequence.size()",
    "float(box.get(\"width\", 0.0)) > 0.0", "float(box.get(\"height\", 0.0)) > 0.0",
    "return Vector2(frame_width, frame_height)",
]), "Godot SpriteEntity current-frame pixel-size/atlas-box translation drift")
require(ordered_tokens(gd_function(gd_sprite_entity, "_apply_sprite_scale"), [
    "_base_texture == null or _anim_def.is_empty()", "Vector2(_facing_x, 1.0)", "return",
    "_get_current_frame_pixel_size()", "(_world_width / frame_size.x) * _facing_x",
    "_world_height / frame_size.y", "sprite.position = Vector2(0.0, -_world_height / 2.0)",
]), "Godot SpriteEntity bottom-anchor/world-size/facing scale translation drift")
require(ordered_tokens(gd_pixel_density_blur_shader, [
    "uniform float strength", "texture(TEXTURE, UV)", "dFdx(UV.x)", "dFdy(UV.x)",
    "dFdx(UV.y)", "dFdy(UV.y)", "max(uv_per_screen_pixel, TEXTURE_PIXEL_SIZE) * strength",
    "REGION_RECT.xy", "REGION_RECT.zw", "for (int y = -1; y <= 1; y++)",
    "for (int x = -1; x <= 1; x++)", "tap.rgb * tap.a", "sum.rgb / max(sum.a",
]), "Godot SpriteEntity inner BlurFilter shader lost screen-pixel/atlas/alpha behavior")
require("var container: Node2D" in gd_npc and "container = Node2D.new()" in gd_npc,
        "Godot Npc does not map the source outer Container to a neutral Node2D")
require(all(token in scene_entity_filter_binding for token in [
    "const META_RENDER_TARGET_KEY", "render_target: CanvasItem = null", "target.set_meta(META_KEY, filter)",
    "target.set_meta(META_RENDER_TARGET_KEY, drawable)", "filter.attach(drawable)",
    "static func get_render_target(", "static func sync_sprite_entity_pixel_density_match(",
    "filter.attach(entity.sprite)", "entity._unmount_pixel_density_blur()",
]), "Godot scene-filter adapter lost logical-container ownership or drawable-pass folding")
require("RuntimeSceneEntityFilterBinding.attach(player.sprite.container, player_depth_filter, player.sprite.sprite)" in bootstrap and
        "RuntimeSceneEntityFilterBinding.attach(npc.container, filter, npc.sprite.sprite)" in bootstrap and
        "RuntimeSceneEntityFilterBinding.get_filter(npc.container)" in bootstrap,
        "Godot Game no longer preserves logical player/NPC filter ownership while targeting the drawable adapter")
require("static func configure_combined_pixel_blur(" in scene_entity_filter_binding and
        "RuntimeSceneEntityFilterBinding.configure_combined_pixel_blur(filter, hotspot.get_display_texture()" in bootstrap and
        bootstrap.count("RuntimeSceneEntityFilterBinding.configure_combined_pixel_blur(") == 3,
        "Godot single-material engine adapter lost player/NPC/hotspot ordered pixel-blur composition")
require(ordered_tokens(gd_function(gd_npc, "apply_entity_pixel_density_match"), [
    "sprite.set_pixel_density_match_active(enabled)",
    "sprite.apply_pixel_density_match(background_density, strength_scale)",
]), "Godot Npc drops SpriteEntity.applyPixelDensityMatch")
require(ordered_tokens(gd_function(bootstrap, "_sync_entity_pixel_density_match"), [
    "RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(player.sprite.container",
    "for npc: RuntimeNpc in scene_manager.get_current_npcs():",
    "RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(npc.container",
    "for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():",
    "hotspot.apply_entity_pixel_density_match(",
]), "Godot Game drops player/NPC/hotspot pixel-density application order")
require(ordered_tokens(gd_sprite_entity_test, [
    "entity is Node2D", "entity.container == entity", "is_same(entity._anim_def, animation_definition)",
    "entity.update(1.0 / 7.0)", "entity.set_direction(-1, 0)", "entity.set_frame_index(-1)",
    "entity.set_logical_state_map(", "entity.apply_pixel_density_match(Vector2(0.1, 0.1), 1.0)",
    "engine adapter must retain source BlurFilter state", "retained_blur.destroyed",
    "completed == 1", "await _assert_nested_filter_pixels()", "destroy must not mutate the caller animation definition",
    "RenderingServer.force_draw(true)",
    "entity filter must preserve the opaque sprite body", "folded density blur must remain visible",
    "transparent sprite bounds must not become an opaque white rectangle",
]), "SpriteEntity regression test lost identity/clock/nested-filter/GPU/lifecycle coverage")
require('("res://tests/sprite_entity_test.tscn", "SpriteEntity 46-manifest atlas contract test: PASS")' in run_tests,
        "SpriteEntity regression test is not registered in the mandatory Godot suite")
source_identity_matrix = [
    int(value)
    for value in re.findall(r"\b[01]\b", section(ts_filter_types, "export const IDENTITY_MATRIX", "];"))
]
gd_identity_matrix = [
    int(value)
    for value in re.findall(r"\b[01]\b", section(gd_filter_types, "const IDENTITY_MATRIX", "]"))
]
require(source_identity_matrix == gd_identity_matrix == [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
], "Godot filter/types IDENTITY_MATRIX drift")
require(ordered_tokens(ts_filter_types, [
    "export const IDENTITY_MATRIX", "export function isValidFilterDef(",
]), "TypeScript filter/types runtime declaration order drift")
require(ordered_tokens(gd_filter_types, [
    "const IDENTITY_MATRIX := [", "static func is_valid_filter_def(",
]), "Godot filter/types runtime declaration order drift")
require(ordered_tokens(gd_function(gd_filter_types, "is_valid_filter_def"), [
    "definition == null or not definition is Dictionary", "return false",
    'definition.get("matrix")', "not matrix is Array or matrix.size() != 20", "return false",
    "matrix.all(", "value is int or value is float",
]), "Godot isValidFilterDef object/length/numeric translation drift")
require(ordered_tokens(ts_filter_loader, [
    "const FILTER_ASSET_BASE", "const filterCache", "export function createFilterFromDef(",
    "export async function loadFilter(", "export function createFilterFromJson(",
    "export function clearFilterCache(",
]), "TypeScript FilterLoader module/function order drift")
require(ordered_tokens(gd_filter_loader, [
    "const FILTER_ASSET_BASE", "static var filter_cache", "static func create_filter_from_def(",
    "static func load_filter(", "static func create_filter_from_json(",
    "static func clear_filter_cache(",
]), "Godot FilterLoader module/function order drift")
require(ordered_tokens(gd_function(gd_filter_loader, "create_filter_from_def"), [
    "ShaderMaterial.new()", "filter.shader = COLOR_MATRIX_SHADER", 'definition.get("matrix")',
    "raw is Array and raw.size() == 20", "RuntimeFilterTypesScript.IDENTITY_MATRIX.duplicate()",
    'filter.set_shader_parameter("color_matrix", Projection(',
    'filter.set_shader_parameter("color_offset"', 'definition.get("alpha")',
    "alpha is int or alpha is float else 1.0", "return filter",
]), "Godot createFilterFromDef fallback/matrix/alpha engine translation drift")
require(ordered_tokens(gd_function(gd_filter_loader, "load_filter"), [
    "if use_cache and filter_cache.has(filter_id):", "return filter_cache[filter_id]",
    '"%s/%s.json" % [FILTER_ASSET_BASE, filter_id]', "RuntimeResourceLocator.get_default()",
    "locator.resolve_url(path, RuntimeResourceLocator.TEXT)", "FileAccess.file_exists(resolved)",
    'last_error = "Filter load failed: %s" % filter_id', "return null", "parser.parse(",
    "RuntimeFilterTypesScript.is_valid_filter_def(data)",
    'last_error = "Invalid filter definition: %s" % filter_id', "return null",
    "create_filter_from_def(data)", "if use_cache:", "filter_cache[filter_id] = filter", "return filter",
]), "Godot loadFilter cache/path/validation/error-channel translation drift")
require(ordered_tokens(gd_function(gd_filter_loader, "create_filter_from_json"), [
    "return create_filter_from_def(json)",
]), "Godot createFilterFromJson delegation drift")
require(ordered_tokens(gd_function(gd_filter_loader, "clear_filter_cache"), ["filter_cache.clear()"]),
        "Godot clearFilterCache translation drift")
require('RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")' in gd_asset_manager and
        "RuntimeFilterLoaderScript.create_filter_from_def(definition)" in gd_asset_manager,
        "Godot AssetManager does not import/delegate filter construction through FilterLoader")
require('RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")' in gd_renderer and
        "RuntimeFilterLoaderScript.load_filter(filter_id)" in gd_renderer,
        "Godot Renderer lost the source standalone FilterLoader fallback")
require("IDENTITY_MATRIX" not in gd_world_filter_pipeline and
        "COLOR_MATRIX_SHADER" not in gd_world_filter_pipeline and
        "_material_from_definition" not in gd_world_filter_pipeline and
        "value is Dictionary" not in gd_world_filter_pipeline,
        "Godot WorldFilterPipeline still owns flattened FilterLoader/types logic")
require(ordered_tokens(ts_world_filter_pipeline, [
    "private target:", "private filters:", "constructor(", "setFilters(", "pushFilter(",
    "popFilter(", "clear()", "getFilters(", "get hasFilters(",
]), "TypeScript WorldFilterPipeline field/method order drift")
require(ordered_tokens(gd_world_filter_pipeline, [
    "var target:", "var filters:", "func _init(", "func set_filters(", "func push_filter(",
    "func pop_filter(", "func clear()", "func get_filters(", "func has_filters(",
]), "Godot WorldFilterPipeline field/method order drift")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "set_filters"), [
    "filters = next_filters", "_apply()",
]), "Godot WorldFilterPipeline setFilters lost caller-array identity")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "push_filter"), [
    "filters = filters + [filter]", "_apply()",
]), "Godot WorldFilterPipeline pushFilter no longer replaces the array like source spread")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "pop_filter"), [
    "filters.pop_back()", "_apply()", "return removed",
]), "Godot WorldFilterPipeline popFilter mutation/apply/return order drift")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "clear"), [
    "filters = []", "_apply()",
]), "Godot WorldFilterPipeline clear no longer replaces the array")
require("return filters" in gd_function(gd_world_filter_pipeline, "get_filters") and
        "duplicate" not in gd_function(gd_world_filter_pipeline, "get_filters") and
        "return not filters.is_empty()" in gd_function(gd_world_filter_pipeline, "has_filters"),
        "Godot WorldFilterPipeline read surface changes source identity/hasFilters semantics")
require(all(token not in gd_world_filter_pipeline for token in [
    "filters.clear()", "filters.push_back(filter)", "target.material = filters.back()",
]), "Godot WorldFilterPipeline retains the old last-filter-only compatibility implementation")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "_apply"), [
    "_unwrap_target()", "target.material = filters[0]", "filters.size() < 2",
    "target.get_parent()", "host_parent.remove_child(target)",
    "for index in range(1, filters.size()):", "CanvasGroup.new()",
    "pass_group.material = filters[index]", "pass_group.add_child(current)",
    "host_parent.add_child(current)",
]), "Godot WorldFilterPipeline ordered CanvasGroup render-pass adapter drift")
require(ordered_tokens(gd_function(gd_world_filter_pipeline, "_unwrap_target"), [
    "var outermost:", "var host_parent:", "target_parent.remove_child(target)",
    "host_parent.remove_child(outermost)", "outermost.free()", "_pass_groups.clear()",
    "host_parent.add_child(target)",
]), "Godot WorldFilterPipeline pass teardown/reparent lifecycle drift")
require(ordered_tokens(gd_world_filter_pipeline_test, [
    "red_to_green", "green_to_blue", "pipeline.set_filters(initial_filters)",
    "is_same(pipeline.get_filters(), initial_filters)", "RenderingServer.force_draw(true)",
    "rendered.b > 0.9", "pipeline.push_filter(red_to_green)",
    "not is_same(pipeline.get_filters(), set_identity)", "pipeline.pop_filter()",
    "is_same(pipeline.get_filters(), pushed_identity)", "pipeline.clear()",
]), "WorldFilterPipeline lost ordered GPU-pass/reference-semantics regression coverage")
require('("res://tests/world_filter_pipeline_test.gd", "WorldFilterPipeline ordered-pass/reference direct-translation test: PASS")' in run_tests,
        "WorldFilterPipeline regression test is not registered in the mandatory Godot suite")
require(ordered_tokens(ts_light_env, [
    "const BASELINE", "const DEG2RAD", "function num(", "function explicitNum(",
    "function color(", "function lengthFromElevation(", "function mergeOne(",
    "export function resolveLightEnv(",
]), "TypeScript lightEnv module/function order drift")
require(ordered_tokens(gd_light_env, [
    "const BASELINE", "const DEG2RAD", "static func _num(", "static func _explicit_num(",
    "static func _color(", "static func _length_from_elevation(", "static func _merge_one(",
    "static func resolve(",
]), "Godot lightEnv module/function order drift")
require(ordered_tokens(gd_function(gd_light_env, "_num"), [
    "value is int or value is float", "is_finite(float(value))", "else fallback",
]), "Godot lightEnv num finite-number fallback drift")
require(ordered_tokens(gd_function(gd_light_env, "_explicit_num"), [
    "value is int or value is float", "is_finite(float(value))", "else null",
]), "Godot lightEnv explicitNum drift")
require(ordered_tokens(gd_function(gd_light_env, "_color"), [
    "not value is Array or value.size() < 3", "return fallback", "for index in 3:",
    "_js_number(value[index])", "clampf(number, 0.0, 4.0)", "fallback[index]", "return output",
]), "Godot lightEnv color coercion/clamp/fallback drift")
require(ordered_tokens(gd_function(gd_light_env, "_length_from_elevation"), [
    "clampf(elevation_degrees, 8.0, 85.0) * DEG2RAD", "cos(elevation)",
    "maxf(sin(elevation), 0.001)", "clampf(cotangent, 0.3, 1.6)",
]), "Godot lightEnv elevation-to-shadow-length drift")
gd_light_merge = gd_function(gd_light_env, "_merge_one")
require(ordered_tokens(gd_light_merge, [
    "if source == null:", "return base", 'src.get("key")', 'src.get("ambient")',
    'src.get("shadow")', 'src.get("ao")', 'source_key.get("azimuthDeg")',
    'source_key.get("elevationDeg")', '"key": {', '"ambient": {', '"shadow": {',
    '"mode": _nullish(', '"enabled": _nullish(', '"darkness": clampf(',
    '"softness": maxf(', '"length": _num(', '"contact": clampf(',
    '"contactSize": maxf(', '"softSamples": clampi(roundi(', '"softRadius": maxf(',
    '"billboard": _nullish(', '"toneStrength": clampf(', '"toneEnabled": _nullish(', '"ao": {',
]), "Godot lightEnv mergeOne field/normalization order drift")
gd_light_resolve = gd_function(gd_light_env, "resolve")
require(ordered_tokens(gd_light_resolve, [
    "BASELINE.key.duplicate(false)", "BASELINE.ambient.duplicate(false)",
    "BASELINE.shadow.duplicate(false)", "BASELINE.ao.duplicate(false)",
    '_merge_one(base, global.get("defaultLightEnv"))', "_merge_one(with_global, scene_environment)",
    'resolved.shadow.mode = _nullish(scene_shadow.get("mode"), _nullish(global.get("shadowMode"), resolved.shadow.mode))',
    'resolved.toneEnabled = _nullish(scene.get("toneEnabled"), _nullish(global.get("toneEnabled"), resolved.toneEnabled))',
    '_explicit_num(scene_shadow.get("length"))', '_explicit_num(global_shadow.get("length"))',
    "_length_from_elevation(resolved.key.elevationDeg)", "return resolved",
]), "Godot resolveLightEnv layer/override/explicit-length precedence drift")
require(ordered_tokens(ts_light_env_curve, [
    "export function prepareLightCurve(", "export function projectToCurveT(",
    "function lerp(", "function lerpRgb(", "function lerpAngleDeg(", "function pair<",
    "function blendNum(", "function blendAngle(", "function blendColor(", "function pick<",
    "function compact<", "export function interpolateLightEnv(", "export function copyResolvedInto(",
]), "TypeScript lightEnvCurve module/function order drift")
require(ordered_tokens(gd_light_env_curve, [
    "static func prepare(", "static func project_to_t(", "static func _lerp(",
    "static func _lerp_rgb(", "static func _lerp_angle_degrees(", "static func _pair(",
    "static func _blend_number(", "static func _blend_angle(", "static func _blend_color(",
    "static func _pick(", "static func _compact(", "static func interpolate(",
    "static func copy_resolved_into(",
]), "Godot lightEnvCurve module/function order drift")
require(ordered_tokens(gd_function(gd_light_env_curve, "prepare"), [
    'definition.get("points") if definition is Dictionary else null',
    "not points is Array or points.size() < 2", "return null", "var cumulative: Array = [0.0]",
    "for index in range(1, points.size()):", "sqrt(delta_x * delta_x + delta_y * delta_y)",
    "not total > 0.000001", "return null", 'return {"points": points, "cum": cumulative, "total": total}',
]), "Godot prepareLightCurve length/original-points translation drift")
require("points.duplicate" not in gd_function(gd_light_env_curve, "prepare"),
        "Godot prepareLightCurve deep-copies source points instead of preserving source reference semantics")
require(ordered_tokens(gd_function(gd_light_env_curve, "project_to_t"), [
    "var best_distance_squared := INF", "var best_arc := 0.0", "for index in range(points.size() - 1):",
    "length_squared > 0.000000001", "if segment_t < 0.0:", "elif segment_t > 1.0:",
    "if distance_squared < best_distance_squared:",
    "float(cumulative[index]) + segment_t * (float(cumulative[index + 1]) - float(cumulative[index]))",
    "clampf(best_arc / total, 0.0, 1.0)",
]), "Godot projectToCurveT nearest-segment/arc translation drift")
require(ordered_tokens(gd_function(gd_light_env_curve, "_lerp_angle_degrees"), [
    "fmod(fmod(b - a, 360.0) + 540.0, 360.0) - 180.0", "a + delta * u",
    "fmod(fmod(result, 360.0) + 360.0, 360.0)",
]), "Godot lightEnvCurve shortest-angle interpolation drift")
require("_blend_group" not in gd_light_env_curve,
        "Godot lightEnvCurve retains an invented generic blend abstraction instead of the source helpers")
gd_light_interpolate = gd_function(gd_light_env_curve, "interpolate")
require(ordered_tokens(gd_light_interpolate, [
    "clampf(t01, 0.0, 1.0) * total", "while segment < points.size() - 2",
    "raw_u * raw_u * (3.0 - 2.0 * raw_u)", '"azimuthDeg": _blend_angle(',
    '"elevationDeg": _blend_number(', '"color": _blend_color(', '"intensity": _blend_number(',
    '"mode": _pick(', '"enabled": _pick(', '"darkness": _blend_number(',
    '"softSamples": _blend_number(', '"billboard": _pick(', "if not key.is_empty():",
    "if not ambient.is_empty():", "if not shadow.is_empty():", 'a.get("toneStrength")',
    'a.get("toneEnabled")', '"contact": _blend_number(', '"form": _blend_number(',
    "if not ao.is_empty():", "return output",
]), "Godot interpolateLightEnv segment/smoothstep/field/pick order drift")
require(ordered_tokens(gd_function(gd_light_env_curve, "copy_resolved_into"), [
    "destination.key.azimuthDeg = source.key.azimuthDeg", "destination.key.elevationDeg = source.key.elevationDeg",
    "destination.key.color = source.key.color", "destination.key.intensity = source.key.intensity",
    "destination.ambient.color = source.ambient.color", "destination.ambient.intensity = source.ambient.intensity",
    "destination.shadow.mode = source.shadow.mode", "destination.shadow.enabled = source.shadow.enabled",
    "destination.shadow.darkness = source.shadow.darkness", "destination.shadow.softness = source.shadow.softness",
    "destination.shadow.length = source.shadow.length", "destination.shadow.contact = source.shadow.contact",
    "destination.shadow.contactSize = source.shadow.contactSize", "destination.shadow.softSamples = source.shadow.softSamples",
    "destination.shadow.softRadius = source.shadow.softRadius", "destination.shadow.billboard = source.shadow.billboard",
    "destination.toneStrength = source.toneStrength", "destination.toneEnabled = source.toneEnabled",
    "destination.ao.contact = source.ao.contact", "destination.ao.form = source.ao.form",
]), "Godot copyResolvedInto field/identity-preserving assignment order drift")
require(ordered_tokens(ts_shadow_field, [
    "const DEG2RAD", "export class UniformShadowField", "constructor(private readonly env", "sample():",
    "(this.env.key.azimuthDeg + 180) * DEG2RAD", "length: this.env.shadow.length",
]), "TypeScript UniformShadowField architecture drift")
require(ordered_tokens(gd_shadow_field, [
    "const DEG2RAD", "var env: Dictionary", "func _init(", "env = next_env", "func sample(",
    '"angleRad": (float(env.key.azimuthDeg) + 180.0) * DEG2RAD', '"length": env.shadow.length',
]), "Godot UniformShadowField architecture/formula/reference drift")
require('get("key"' not in gd_shadow_field and 'get("shadow"' not in gd_shadow_field,
        "Godot UniformShadowField invents fallbacks absent from the resolved-env source contract")
require(ordered_tokens(ts_deterministic_random, [
    "export function seedUtf8Fnv1a(", "export function createDeterministicRandom(",
    "export class DeterministicRandom", "private state", "constructor(", "next():", "getState():", "setState(",
]), "TypeScript DeterministicRandom architecture drift")
require(ordered_tokens(gd_deterministic_random, [
    "var state", "func _init(", "static func seed_utf8_fnv1a(",
    "static func create_deterministic_random(", "func next(", "func get_state(", "func set_state(",
]), "Godot DeterministicRandom architecture/order drift")
require(ordered_tokens(gd_function(gd_deterministic_random, "create_deterministic_random"), [
    "var random := RuntimeDeterministicRandom.new(seed_text)",
    "return func() -> float: return random.next()",
]), "Godot createDeterministicRandom closure does not retain its source-owned PRNG instance")
require("var runtime_random: RuntimeDeterministicRandom" in bootstrap and 'RuntimeDeterministicRandomScript.new("gamedraft-runtime-v1")' in bootstrap, "Godot Game does not own the translated DeterministicRandom object")
require("_seed_runtime_random" not in bootstrap and "_next_runtime_random" not in bootstrap and "runtime_random_state" not in bootstrap, "Godot Game retains flattened PRNG algorithm/state ownership")
require(ordered_tokens(ts_click_continue_prompt, [
    "const BOTTOM_MARGIN = 28", "function layoutHintText(", "export function waitClickContinueWithHint(",
    "new Container()", "new Text({", "subscribeAfterResize(", "const finish =", "const arm =",
    "requestAnimationFrame(() =>", "requestAnimationFrame(arm)",
]), "TypeScript ClickContinuePrompt architecture drift")
require(ordered_tokens(gd_click_continue_prompt, [
    "const BOTTOM_MARGIN := 28.0", "static func _layout_hint_text(",
    "static func wait_click_continue_with_hint(", "Control.new()", "Label.new()",
    "subscribe_after_resize(", '"finished": false', "var finish :=", "await renderer.get_tree().process_frame",
    "input_manager.subscribe_any_input(", "await completion.wait()",
]), "Godot ClickContinuePrompt architecture/order drift")
require('RuntimeClickContinuePromptScript := preload("res://scripts/ui/click_continue_prompt.gd")' in bootstrap, "Godot Game does not import the translated ClickContinuePrompt module")
require("RuntimeClickContinuePromptScript.wait_click_continue_with_hint(renderer, input_manager, label)" in bootstrap, "Godot Game does not delegate waitClickContinue to the translated module")
require("_wait_click_continue_from_action" not in bootstrap and "wait_click_serial" not in bootstrap, "Godot Game retains ClickContinuePrompt state/implementation ownership")
require(ordered_tokens(ts_scripted_dialogue_speaker, [
    "export type ScriptedSpeakerResolveCtx", "export function resolveScriptedSpeakerDisplay(",
    "const graphId", "const fbId", "while (i < s.length)", "if (kind === 'player')",
    "else if (kind === 'npc')", "export type ScriptedSpeakerEntity",
    "export function resolveScriptedSpeakerEntity(", "if (kind === 'player')", "if (kind === 'npc')",
]), "TypeScript scriptedDialogueSpeaker architecture drift")
require(ordered_tokens(gd_scripted_dialogue_speaker, [
    "static func resolve_scripted_speaker_display(", "var graph_id", "var fallback_id",
    "while offset < source.length()", 'if kind == "player"', 'elif kind == "npc"',
    "static func resolve_scripted_speaker_entity(", 'if kind == "player"', 'if kind == "npc"',
]), "Godot scriptedDialogueSpeaker architecture/order drift")
require('RuntimeScriptedDialogueSpeakerScript := preload("res://scripts/utils/scripted_dialogue_speaker.gd")' in bootstrap, "Godot Game does not import the translated scriptedDialogueSpeaker module")
require(bootstrap.count("RuntimeScriptedDialogueSpeakerScript.resolve_scripted_speaker_display(") == 2, "Godot Game scripted speaker display call sites drift")
require("RuntimeScriptedDialogueSpeakerScript.resolve_scripted_speaker_entity(" in bootstrap, "Godot Game does not delegate scripted speaker entity resolution")
require("func _resolve_scripted_speaker(" not in bootstrap and "func _resolve_scripted_speaker_entity(" not in bootstrap, "Godot Game retains scriptedDialogueSpeaker implementation ownership")
require(ordered_tokens(ts_animation_set_resolver, [
    "const DEFAULT_WORLD_WIDTH = 100", "export function effectiveCellPixelSize(",
    "export function resolveAnimationWorldSize(", "export function normalizeAnimationSetDef(",
]), "TypeScript resolveAnimationSet architecture drift")
require(ordered_tokens(gd_animation_set_resolver, [
    "const DEFAULT_WORLD_WIDTH := 100.0", "static func effective_cell_pixel_size(",
    "static func resolve_animation_world_size(", "static func normalize_animation_set_def(",
]), "Godot resolveAnimationSet architecture/order drift")
require("resolve_path_relative_to_anim_manifest" not in gd_animation_set_resolver,
        "Godot resolveAnimationSet target steals assetPath module ownership")
require(ordered_tokens(ts_asset_path, [
    "export function resolvePathRelativeToAnimManifest(", "const r = (ref || '').trim()",
    "r.startsWith('http://')", "r.startsWith('/assets/')", "const base = animManifestPath.replace(",
]), "TypeScript animation-manifest relative-path contract drift")
require(ordered_tokens(gd_resource_locator, [
    "func resolve_anim_relative(", "var value := ref.strip_edges()", 'value.begins_with("http://")',
    'value.begins_with("/assets/")', "var last_slash := base.rfind(\"/\")",
]), "Godot assetPath animation-manifest relative-path contract drift")
require(ordered_tokens(ts_placeholder_factory, [
    "export function createPlaceholderBackground(", "const container = new Container()",
    "export function createPlaceholderPlayerTextures(", "const frameWidth = 32", "const frameHeight = 48",
    "const frameCount = 6", "for (let i = 0; i < frameCount; i++)", "RenderTexture.create(",
]), "TypeScript PlaceholderFactory architecture drift")
require(ordered_tokens(gd_placeholder_factory, [
    "static func create_placeholder_background(", "var container := Node2D.new()",
    "static func create_placeholder_player_textures(", "var frame_width := 32", "var frame_height := 48",
    "var frame_count := 6", "for index in frame_count", "ImageTexture.create_from_image(image)",
]), "Godot PlaceholderFactory architecture/order drift")

archive_ui_pairs = [
    (
        "BookshelfUI", ts_bookshelf_ui, gd_bookshelf_ui,
        ["renderer", "archive_data", "container", "_is_open", "active_sub_panel", "on_open_rules", "on_open_book", "on_open_characters", "on_open_lore", "on_open_documents", "strings"],
        ["_init", "is_open", "open", "close", "_build_shelf", "_draw_book_slot", "_on_book_click", "_close_sub_panel", "_destroy_shelf_only", "_destroy_ui", "destroy"],
        ["private renderer", "private archiveData", "private container", "private _isOpen", "private activeSubPanel", "private onOpenRules", "private onOpenBook", "private onOpenCharacters", "private onOpenLore", "private onOpenDocuments", "private strings", "constructor(", "get isOpen", "open():", "close():", "private buildShelf", "private drawBookSlot", "private onBookClick", "private closeSubPanel", "private destroyShelfOnly", "private destroyUI", "destroy():"],
    ),
    (
        "CharacterBookUI", ts_character_book_ui, gd_character_book_ui,
        ["renderer", "archive_data", "asset_manager", "container", "detail_container", "detail_mask", "detail_scroll_offset", "detail_total_h", "on_close", "strings", "list_scroll_offset", "list_content_h", "list_container", "on_wheel_bound", "panel_x"],
        ["_init", "destroy", "open", "close", "_build", "_show_detail", "_on_wheel", "_destroy_ui"],
        ["private renderer", "private archiveData", "private assetManager", "private container", "private detailContainer", "private detailMask", "private detailScrollOffset", "private detailTotalH", "private onClose", "private strings", "private listScrollOffset", "private listContentH", "private listContainer", "private onWheelBound", "private panelX", "constructor(", "destroy():", "open():", "close():", "private build", "private showDetail", "private onWheel", "private destroyUI"],
    ),
    (
        "LoreBookUI", ts_lore_book_ui, gd_lore_book_ui,
        ["renderer", "archive_data", "asset_manager", "container", "on_close", "strings", "content_container", "content_mask", "content_scroll_offset", "content_total_h", "list_scroll_offset", "list_content_h", "list_container", "on_wheel_bound", "panel_x"],
        ["_init", "destroy", "open", "close", "_build", "_show_content", "_category_label", "_on_wheel", "_destroy_ui"],
        ["private renderer", "private archiveData", "private assetManager", "private container", "private onClose", "private strings", "private contentContainer", "private contentMask", "private contentScrollOffset", "private contentTotalH", "private listScrollOffset", "private listContentH", "private listContainer", "private onWheelBound", "private panelX", "constructor(", "destroy():", "open():", "close():", "private build", "private showContent", "private categoryLabel", "private onWheel", "private destroyUI"],
    ),
    (
        "DocumentBoxUI", ts_document_box_ui, gd_document_box_ui,
        ["renderer", "archive_data", "asset_manager", "container", "content_container", "content_mask", "content_scroll_offset", "content_total_h", "list_scroll_offset", "list_content_h", "list_container", "on_wheel_bound", "on_close", "strings", "panel_x"],
        ["_init", "destroy", "open", "close", "_build", "_show_content", "_on_wheel", "_destroy_ui"],
        ["private renderer", "private archiveData", "private assetManager", "private container", "private contentContainer", "private contentMask", "private contentScrollOffset", "private contentTotalH", "private listScrollOffset", "private listContentH", "private listContainer", "private onWheelBound", "private onClose", "private strings", "private panelX", "constructor(", "destroy():", "open():", "close():", "private build", "private showContent", "private onWheel", "private destroyUI"],
    ),
    (
        "BookReaderUI", ts_book_reader_ui, gd_book_reader_ui,
        ["renderer", "archive_data", "asset_manager", "container", "current_book", "nav_page_num", "nav_entry_id", "on_close_cb", "on_wheel_bound", "strings", "content_container", "content_scroll_offset", "content_total_h", "scroll_anchor_y", "content_viewport_h", "toc_container", "toc_scroll_offset", "toc_total_h", "toc_viewport_h", "toc_anchor_y", "wheel_layout"],
        ["_init", "open_book", "_navigate", "_fire_slice_first_view", "close", "destroy", "_resolve_slice", "_build", "_breadcrumb_text", "_on_wheel", "_destroy_ui"],
        ["private renderer", "private archiveData", "private assetManager", "private container", "private currentBook", "private navPageNum", "private navEntryId", "private onCloseCb", "private onWheelBound", "private strings", "private contentContainer", "private contentScrollOffset", "private contentTotalH", "private scrollAnchorY", "private contentViewportH", "private tocContainer", "private tocScrollOffset", "private tocTotalH", "private tocViewportH", "private tocAnchorY", "private wheelLayout", "constructor(", "openBook(", "private navigate", "private fireSliceFirstView", "close():", "destroy():", "private resolveSlice", "private build", "private breadcrumbText", "private onWheel", "private destroyUI"],
    ),
]
for ui_name, ts_ui, gd_ui, expected_fields, expected_methods, source_tokens in archive_ui_pairs:
    require(ordered_tokens(ts_ui, source_tokens), f"TypeScript {ui_name} field/method architecture drift")
    gd_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_ui, flags=re.MULTILINE)
    gd_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_ui, flags=re.MULTILINE)
    require(gd_fields == expected_fields, f"Godot {ui_name} field architecture/order drift: {gd_fields}")
    require(gd_methods == expected_methods, f"Godot {ui_name} method architecture/order drift: {gd_methods}")
    require("extends RefCounted" in gd_ui and "RuntimeArchiveEntryPanel" not in gd_ui and "RuntimeTextPanel" not in gd_ui, f"Godot {ui_name} retains a non-source UI inheritance layer")
require(not (PORT / "scripts/ui/archive_entry_panel.gd").exists(), "orphan non-source RuntimeArchiveEntryPanel remains in the target architecture")
require('"id": "book_%s"' in gd_bookshelf_ui and 'book_id.substr(5)' in gd_bookshelf_ui, "Godot BookshelfUI dynamic-book id namespace drift")
require("func open_book(book: Dictionary, on_close: Callable)" in gd_book_reader_ui and "func _fire_slice_first_view()" in gd_book_reader_ui, "Godot BookReaderUI callback/first-view boundary drift")
require(ordered_tokens(bootstrap, [
    "book_reader_ui = RuntimeBookReaderUI.new(renderer, archive_manager, strings_provider, asset_manager)",
    "state_controller.restore_previous_state()", 'state_controller.toggle_panel("rules")',
    "book_reader_ui.open_book(book, on_close)",
    "RuntimeCharacterBookUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)", "shelf.open()",
    "RuntimeLoreBookUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)", "shelf.open()",
    "RuntimeDocumentBoxUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)", "shelf.open()",
    "bookshelf_ui = RuntimeBookshelfUI.new(", "on_open_rules", "on_open_book", "on_open_characters", "on_open_lore", "on_open_documents", "strings_provider",
]), "Godot Game archive-UI factory ownership/order drift")
require("character_book_ui" not in bootstrap and "lore_book_ui" not in bootstrap and "document_box_ui" not in bootstrap, "Godot Game retains non-source archive subpanel fields")

expected_game_fields = [
    "event_bus", "flag_store", "strings_provider", "input_manager", "asset_manager", "action_executor",
    "renderer", "camera", "player", "interaction_system", "scene_manager", "dialogue_manager",
    "graph_dialogue_manager", "scenario_state_manager", "narrative_state_manager", "document_reveal_manager",
    "quest_manager", "rules_manager", "inventory_manager", "encounter_manager", "audio_manager", "day_manager",
    "cutscene_manager", "cutscene_renderer", "resolve_actor_fn", "scene_display_name_by_id", "npc_display_name_by_id",
    "archive_manager", "emote_bubble_manager", "rule_offer_registry", "zone_system", "save_manager", "inspect_box",
    "pickup_notification", "dialogue_ui", "encounter_ui", "action_choice_ui", "hud", "notification_ui",
    "quest_panel_ui", "inventory_ui", "rules_panel_ui", "dialogue_log_ui", "bookshelf_ui", "book_reader_ui",
    "shop_ui", "map_ui", "menu_ui", "rule_use_ui", "debug_panel_ui", "cutscene_step_hud_el", "state_controller",
    "last_time", "last_fps", "play_time_ms", "runtime_random", "player_anim_def", "interaction_coordinator",
    "event_bridge", "debug_tools", "scene_depth_system", "water_minigame_manager", "sugar_wheel_minigame_manager",
    "paper_craft_minigame_manager", "pressure_hold_manager", "signal_cue_manager", "health_system", "smell_system",
    "plane_reconciler", "smell_profiles_data", "pressure_hold_ui", "depth_debug_visualizer", "player_depth_filter",
    "current_probe", "current_light_env", "current_light_curve", "plane_light_env_override", "current_shadow_field",
    "entity_shadows", "ambient_narrative_owner", "entity_pixel_density_match_debug_override",
    "entity_pixel_density_match_blur_scale_debug", "patrol_generation", "npc_patrol_epoch", "main_tick",
    "gl_post_render_drain", "webgl_context_lost_handler", "webgl_context_restored_handler",
    "runtime_debug_log_cleanup", "runtime_debug_snapshot_timer", "runtime_command_poll_timer",
    "runtime_command_poll_in_flight", "runtime_boot_id", "runtime_debug_snapshot_error_logged", "fixed_tick_mode",
    "runtime_ready", "runtime_command_poll_error_logged", "last_runtime_command_results", "registered_systems",
    "bound_callbacks", "bound_window_listeners", "unsub_renderer_resize", "tear_down_complete", "is_dev_mode",
    "smell_debug_global_keys", "dev_mode_ui", "touch_mobile_controls", "overlay_image_registry", "game_config",
    "current_player_portrait_slug", "narrative_warps", "dev_startup_route", "player_nav_target", "player_nav_frames",
    "player_nav_prev", "player_nav_stuck",
]
gd_game_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", bootstrap, flags=re.MULTILINE)
require(gd_game_fields[:len(expected_game_fields)] == expected_game_fields, f"Godot Game source field order/ownership drift: {gd_game_fields[:len(expected_game_fields)]}")
require(gd_game_fields[len(expected_game_fields):] == [
    "runtime_root", "runtime_command_bridge",
], f"Godot Game unclassified extra fields drift: {gd_game_fields[len(expected_game_fields):]}")

# Game is the composition root, so a few hand-picked token checks are not
# sufficient evidence of code-level translation. Every source method must have
# exactly one snake_case counterpart and those direct counterparts must remain
# in source declaration order. Any additional Godot method must be an explicitly
# classified engine/closure adapter rather than an invented domain API.
ts_game_class = game[game.index("export class Game {"):]
ts_game_method_names = re.findall(
    r"^  (?:(?:private|public|protected)\s+)?(?:(?:static|async)\s+)*(?:get\s+|set\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(",
    ts_game_class,
    flags=re.MULTILINE,
)
ts_game_method_order = ["init" if name == "constructor" else snake_case(name) for name in ts_game_method_names]
gd_game_methods = re.findall(r"^(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", bootstrap, flags=re.MULTILINE)
gd_game_canonical_methods = [name.removeprefix("_") for name in gd_game_methods]
gd_game_direct_method_order = [name for name in gd_game_canonical_methods if name in ts_game_method_order]
require(len(ts_game_method_order) == 126, f"TypeScript Game method inventory drift: {len(ts_game_method_order)}")
require(len(gd_game_direct_method_order) == len(ts_game_method_order)
        and len(set(gd_game_direct_method_order)) == len(ts_game_method_order),
        f"Godot Game direct method coverage/uniqueness drift: {gd_game_direct_method_order}")
require(gd_game_direct_method_order == ts_game_method_order,
        f"Godot Game direct method declaration order drift: {gd_game_direct_method_order}")
expected_game_adapter_methods = [
    "_ready", "_on_dialogue_line_speaking_bubble", "_clear_dialogue_speaking_bubble",
    "get_ambient_narrative_owner", "_resolve_action_actor", "_switch_scene_for_cutscene",
    "_resolve_cutscene_spawn_point", "run_scene_enter_actions", "play_scripted_dialogue_from_action",
    "_start_dialogue_graph_from_action", "evaluate_runtime_conditions", "_evaluate_sugar_wheel_condition",
    "reload_saved_scene", "_run_pressure_hold_segment", "_show_debug_action_params", "_on_archive_first_view",
    "_on_renderer_resize", "_build_debug_system_info", "_load_scene_depth_runtime",
    "_unload_scene_depth_runtime", "_active_depth_floor_zones", "_depth_floor_offset",
    "_update_scene_depth_runtime", "_on_scene_before_unload_runtime_sync", "_on_scene_ready_runtime_sync",
    "_is_player_world_collision", "_on_scene_entities_rebuilt_runtime_sync", "get_narrative_warp_entries",
    "_get_dev_minigame_entries", "_dev_launch_minigame", "_cycle_entity_pixel_density_match_debug_override",
    "_get_debug_scene_world_size", "_scenario_debug_activate", "_scenario_debug_complete",
    "_scenario_debug_reset_incomplete", "_list_smell_debug_profiles", "_sorted_strings", "_build_render_state",
    "_schedule_runtime_debug_snapshot_from_event", "_build_runtime_command_dependencies",
    "_capture_runtime_command_snapshot", "_debug_set_fixed_tick_mode", "_debug_switch_scene",
    "_debug_reload_scene", "_exit_tree", "_process", "_update_scene_npcs_and_patrol",
]
gd_game_adapter_methods = [name for name in gd_game_methods if name.removeprefix("_") not in ts_game_method_order]
require(gd_game_adapter_methods == expected_game_adapter_methods,
        f"Godot Game unclassified adapter method/order drift: {gd_game_adapter_methods}")

gd_game_listen_event = gd_function(bootstrap, "listen_event")
gd_game_add_window_listener = gd_function(bootstrap, "add_window_listener")
gd_game_destroy = gd_function(bootstrap, "destroy")
require(ordered_tokens(gd_game_listen_event, [
    "event_bus.on(event, fn)", 'bound_callbacks.push_back({"event": event, "fn": fn})',
]), "Godot Game.listenEvent callback identity/ownership drift")
require(ordered_tokens(gd_game_add_window_listener, [
    'event != "resize"', "get_viewport().size_changed", "resize_signal.connect(fn)",
    'bound_window_listeners.push_back({"event": event, "fn": fn})',
]), "Godot Game.addWindowListener native resize ownership drift")
require(ordered_tokens(gd_game_destroy, [
    "runtime_debug_snapshot_timer = null", "runtime_command_poll_timer = null",
    "runtime_command_poll_in_flight = false", "runtime_command_bridge.unbind()",
    "for binding: Dictionary in bound_callbacks:", "event_bus.off(str(binding.event), binding.fn)",
    "bound_callbacks.clear()", "cutscene_step_hud_el.free()", "cutscene_step_hud_el = null",
    "for binding: Dictionary in bound_window_listeners:", "resize_signal.disconnect(binding.fn)",
    "bound_window_listeners.clear()", "unsub_renderer_resize.call()", "unsub_renderer_resize = Callable()",
]), "Godot Game.destroy timer/listener/HUD/resize cleanup order drift")

ts_text_resolve_methods = section(game, "private buildResolveContext()", "async start(")
require(ordered_tokens(ts_text_resolve_methods, [
    "private buildResolveContext()", "itemNames: this.archiveManager.getItemDisplayNames()",
    "playerDisplayName:", "defaultProtagonistName", ": '你'", "resolveDisplayText(",
    "resolveDisplayTextForPlayScripted(", "const base = this.buildResolveContext()",
    "private resolveScriptedLineExtras(", "private resolveScriptedPortrait(",
    "private resolveEmoteTarget(", "private async refreshTextResolveLookups(", "private wireTextResolve()",
]), "TypeScript Game text-resolution method architecture drift")
require(ordered_tokens(bootstrap, [
    "func build_resolve_context()", '"itemNames": archive_manager.get_item_display_names()',
    'else "你"', "func resolve_display_text(", "build_resolve_context()",
    "func resolve_display_text_for_play_scripted(", "var context := build_resolve_context()",
    "func _resolve_scripted_line_extras(", "func _resolve_scripted_portrait(",
    "func _resolve_emote_target(", "func _refresh_text_resolve_lookups(", "func wire_text_resolve()",
]), "Godot Game text-resolution method architecture/order drift")
gd_text_resolve_methods = section(bootstrap, "func build_resolve_context()", "func get_ambient_narrative_owner()")
require("inventory_manager.get_item_name_map" not in gd_text_resolve_methods, "Godot Game resolves item tags from InventoryManager instead of source ArchiveManager")
require(ordered_tokens(section(bootstrap, "func wire_text_resolve()", "func get_ambient_narrative_owner()"), [
    "strings_provider.set_resolve_display(resolve)", "action_executor.set_resolve_notification_text(resolve)",
    "graph_dialogue_manager.set_resolve_display(resolve)", "document_reveal_manager.set_resolve_condition_literal(resolve)",
    "encounter_manager.set_resolve_display(resolve)", "archive_manager.set_resolve_for_display(",
    "inspect_box.set_resolve_display(resolve)", "shop_ui.set_resolve_display(resolve)",
    "map_ui.set_resolve_display(resolve)", "quest_panel_ui.set_resolve_display(resolve)",
    "rules_panel_ui.set_resolve_display(resolve)", "inventory_ui.set_resolve_display(resolve)",
    "cutscene_renderer.set_resolve_display(resolve)", "set_colon_speaker_narrator_baseline_resolved(",
    "cutscene_manager.set_display_text_resolver(resolve)", "hud.set_resolve_display(resolve)",
    "rule_use_ui.set_resolve_display(resolve)",
]), "Godot Game wireTextResolve dependency/order drift")
require(ordered_tokens(gd_function(bootstrap, "start"), ["_refresh_text_resolve_lookups()", "wire_text_resolve()"]), "Godot Game text lookup/wiring startup order drift")

game_init = section(bootstrap, "func _init()", "func _ready()")
require(ordered_tokens(game_init, [
    "RuntimeEventBus.new()", "RuntimeFlagStore.new(event_bus)", "RuntimeStringsProvider.new()",
    "RuntimeInputManager.new()", "RuntimeAssetManager.new()", "RuntimeGameStateController.new(",
    "RuntimeActionExecutor.new(", "RuntimeRuleOfferRegistry.new()", "RuntimeRenderer.new()",
    "renderer.set_asset_manager(asset_manager)", "RuntimeCamera.new(renderer.world_container)",
    "RuntimePlayer.new(input_manager)", "RuntimeInteractionSystem.new(", "RuntimeSceneManager.new(",
    "RuntimeInventoryManager.new(", "RuntimeRulesManager.new(", "RuntimeDialogueManager.new(",
    "RuntimeQuestManager.new(", "RuntimeScenarioStateManager.new()", "RuntimeNarrativeStateManager.new(",
    "RuntimeGraphDialogueManager.new(", "set_player_portrait_slug_provider", "RuntimeDocumentRevealManager.new(",
    "RuntimeEncounterManager.new(", "RuntimeAudioManager.new(", "RuntimeDayManager.new(",
    "RuntimeWaterMinigameManager.new()", "RuntimeSugarWheelMinigameManager.new()",
    "RuntimePaperCraftMinigameManager.new()", "RuntimePressureHoldManager.new(", "RuntimeSignalCueManager.new(",
    "RuntimeHealthSystem.new(", "RuntimeSmellSystem.new(", "RuntimePlaneReconciler.new(",
    "RuntimeArchiveManager.new(", "RuntimeEmoteBubbleManager.new()", "RuntimeZoneSystem.new(",
    "RuntimeSceneDepthSystem.new()", "registered_systems = [", "runtime_root.attach_system_slots(registered_systems)",
    "for entry: Dictionary in registered_systems:", "entry.system.init(game_context)",
]), "Godot Game _init constructor statement order drift")
game_start = gd_function(bootstrap, "start")

require(ordered_tokens(game_start, [
    "renderer.init(", "emote_bubble_manager.set_entity_attach_layer(",
    "strings_provider.load(asset_manager)", "await _load_game_config()",
    'game_config.get("windowSize")', 'game_config.get("viewport")',
    "health_system.configure(", "health_system.init(game_context)",
    "inspect_box = RuntimeInspectBox.new(", "pickup_notification = RuntimePickupNotification.new(",
    "dialogue_ui = RuntimeDialogueUI.new(", 'event_bus.on("dialogue:line"',
    'event_bus.on("dialogue:end"', 'event_bus.on("dialogue:hidePanel"',
    "encounter_ui = RuntimeEncounterUI.new(", "action_choice_ui = RuntimeActionChoiceUI.new(",
    "pressure_hold_ui = RuntimePressureHoldUI.new(", "hud = RuntimeHUD.new(",
    "notification_ui = RuntimeNotificationUI.new(", "quest_panel_ui = RuntimeQuestPanelUI.new(",
    "inventory_ui = RuntimeInventoryUI.new(", "rules_panel_ui = RuntimeRulesPanelUI.new(",
    "dialogue_log_ui = RuntimeDialogueLogUI.new(", "book_reader_ui = RuntimeBookReaderUI.new(",
    "bookshelf_ui = RuntimeBookshelfUI.new(", "shop_ui = RuntimeShopUI.new(",
    "map_ui = RuntimeMapUI.new(", "cutscene_renderer = RuntimeCutsceneRenderer.new(",
    "cutscene_manager = RuntimeCutsceneManager.new(", "cutscene_manager.init(game_context)",
    "registered_systems.find_custom(", 'entry.name == "cutsceneManager"',
    "registered_systems[cutscene_system_index].system = cutscene_manager",
    "save_manager = RuntimeSaveManager.new(", "save_manager.set_can_save_predicate(",
    "menu_ui = RuntimeMenuUI.new(", "rule_use_ui = RuntimeRuleUseUI.new(",
    "debug_panel_ui = RuntimeDebugPanelUI.new(", "emote_bubble_manager.set_debug_panel_log(",
    "camera.set_screen_size(", "renderer.subscribe_after_resize(", 'add_window_listener("resize"',
    "setup_scene_manager()", "_register_ui_panels()", "encounter_manager.set_rule_name_resolver(",
    "set_condition_eval_context_factory(condition_factory)", "plane_reconciler.bind_runtime({",
    "document_reveal_manager.load_definitions()", "scenario_state_manager.configure_runtime(",
    "narrative_state_manager.load_from_asset(", "RuntimeActionRegistryScript.register_action_handlers(",
    "interaction_coordinator.init()", 'listen_event("archive:firstView"', "event_bridge.init()",
    "setup_scene_ready_handler()", "depth_debug_visualizer = RuntimeDepthDebugVisualizer.new(",
    "debug_tools.init()", "load_flag_registry()", "wire_text_resolve()",
    "debug_panel_ui.attach_flag_debug(", "setup_cutscene_step_hud()", "setup_plane_debug_section()",
    "save_manager.set_fallback_scene(", 'await setup_player({"deferAvatar": is_dev_mode})',
    "setup_runtime_debug_snapshot_publishing()", "if is_dev_mode:", "await start_dev_mode(",
    "await scene_manager.load_initial_scene(initial_scene)", "await _try_start_initial_prologue(",
    "last_time = float(Time.get_ticks_msec())", "main_tick = func(delta: float)", "set_process(true)",
    "setup_web_gl_panel_diagnostics()", "dev_startup_route.is_valid()", "runtime_ready = true",
    "setup_runtime_command_polling()", 'await publish_runtime_debug_snapshot("runtime-ready")',
]), "Godot Game.start full source-phase construction/order drift")

# Game.start is a domain API.  Browser URL / Godot command-line parsing belongs
# to the platform entry adapter and must collapse to the same eight source
# options before the translated method is entered.
expected_start_options = [
    "devMode", "playCutscene", "devScene", "narrativeWarp", "waterPreview",
    "sugarWheelPreview", "paperCraftPreview", "visualCapture",
]
ts_start_options = section(game, "export interface GameStartOptions {", "\n}")
ts_start_option_fields = re.findall(r"^\s{2}([A-Za-z_][A-Za-z0-9_]*)\?:", ts_start_options, flags=re.MULTILINE)
require(ts_start_option_fields == expected_start_options, f"TypeScript GameStartOptions field/order drift: {ts_start_option_fields}")

adapter_string_options = section(gd_game_startup_adapter, "const STRING_OPTIONS := {", "\n}")
adapter_string_option_fields = re.findall(r'^\t"([A-Za-z_][A-Za-z0-9_]*)"\s*:', adapter_string_options, flags=re.MULTILINE)
require(adapter_string_option_fields == expected_start_options[1:7], f"Godot startup adapter string-option surface drift: {adapter_string_option_fields}")
adapter_options_initializer = section(gd_game_startup_adapter, "\tvar options := {", "\n\t}")
adapter_option_fields = re.findall(r'^\t\t"([A-Za-z_][A-Za-z0-9_]*)"\s*:', adapter_options_initializer, flags=re.MULTILINE)
require(adapter_option_fields == expected_start_options + ["_godotInitialScene"], f"Godot startup adapter canonical option surface drift: {adapter_option_fields}")
require(set(adapter_option_fields) - set(expected_start_options) == {"_godotInitialScene"}, "Godot startup adapter has more than the one declared engine-only start field")
require(ordered_tokens(adapter_options_initializer, [
    '"devMode": _read_command_line_bool(', '"playCutscene": _read_command_line_string(',
    '"devScene": _read_command_line_string(', '"narrativeWarp": _read_command_line_string(',
    '"waterPreview": _read_command_line_string(', '"sugarWheelPreview": _read_command_line_string(',
    '"paperCraftPreview": _read_command_line_string(', '"visualCapture": _read_command_line_bool(',
    '"_godotInitialScene": _read_command_line_string(',
]), "Godot startup adapter command-line normalization order drift")
adapter_from_engine = gd_function(gd_game_startup_adapter, "from_engine")
require(ordered_tokens(adapter_from_engine, [
    "var command_line := _parse_command_line(user_args)", "var options := {",
    'engine_owner.get_meta("startOptions", {})', "var start_options: Dictionary = metadata",
    'if start_options.has("devMode"):', "options.devMode = _coerce_bool(",
    "for canonical: String in STRING_OPTIONS:", "options[canonical] = _coerce_string(",
    'if start_options.has("visualCapture"):', "options.visualCapture = _coerce_bool(",
    'if start_options.has("_godotInitialScene"):', "options._godotInitialScene = _coerce_string(",
    'elif start_options.has("parity-start-scene"):', 'options._godotInitialScene = _coerce_string(start_options["parity-start-scene"])',
    "return options",
]), "Godot startup adapter metadata-over-command-line precedence drift")
for leaked_adapter_option in [
    "parity-request", "parity_request", "parity-response", "parity_response", "parity-quit", "parity_quit",
    "notAStartOption", "startDialogue", "emitSignal",
]:
    require(leaked_adapter_option not in gd_game_startup_adapter, f"Godot startup adapter leaks a non-GameStartOptions field: {leaked_adapter_option}")
require("options.merge(" not in adapter_from_engine and "return command_line" not in adapter_from_engine,
        "Godot startup adapter forwards unclassified engine arguments into Game.start")

game_ready = gd_function(bootstrap, "_ready")
require(ordered_tokens(game_ready, [
    "set_process(false)", "await start(RuntimeGameStartupAdapter.from_engine(self, OS.get_cmdline_user_args()))",
]), "Godot _ready adapter must gate tick and pass normalized engine options to Game.start")
require(bootstrap.count("RuntimeGameStartupAdapter.from_engine(") == 1, "Godot startup adapter must have one _ready entry boundary")
require(game_start.startswith("func start(options: Dictionary = {}) -> void:"), "Godot Game.start options signature drift")
require("_command_line_option" not in bootstrap and "OS.get_cmdline" not in game_start,
        "Godot Game domain reads command-line state instead of accepting GameStartOptions")

ts_start_tail = section(game, "await this.setupPlayer({ deferAvatar: this.isDevMode })", "\n  /** F2")
require(ordered_tokens(ts_start_tail, [
    "await this.setupPlayer({ deferAvatar: this.isDevMode })", "if (this.tearDownComplete) return",
    "this.setupRuntimeDebugSnapshotPublishing()", "if (this.isDevMode)", "await this.startDevMode(",
    "options.playCutscene", "options.waterPreview", "options.sugarWheelPreview", "options.paperCraftPreview",
    "options.devScene", "options.narrativeWarp", "options.visualCapture === true", "} else {",
    "this.questManager.acceptQuest(this.gameConfig.initialQuest)",
    "await this.sceneManager.loadInitialScene(this.gameConfig.initialScene)", "await this.tryStartInitialPrologue()",
    "if (this.tearDownComplete || !this.renderer.isInitialized())", "this.mainTick = () =>", "ticker.add(this.mainTick)",
    "this.setupWebGlPanelDiagnostics()", "if (this.devStartupRoute)", "const route = this.devStartupRoute",
    "this.devStartupRoute = null", "await route()", "if (this.tearDownComplete || !this.renderer.isInitialized()) return",
    "this.runtimeReady = true", "this.setupRuntimeCommandPolling()", "await this.publishRuntimeDebugSnapshot('runtime-ready')",
]), "TypeScript Game.start player/branch/ticker/dev-route/ready tail drift")

require(ordered_tokens(game_start, [
    'await setup_player({"deferAvatar": is_dev_mode})', "if tear_down_complete: return",
    "setup_runtime_debug_snapshot_publishing()", "if is_dev_mode:", "await start_dev_mode(",
    'str(options.get("playCutscene", ""))', 'str(options.get("waterPreview", ""))',
    'str(options.get("sugarWheelPreview", ""))', 'str(options.get("paperCraftPreview", ""))',
    'str(options.get("devScene", ""))', 'str(options.get("narrativeWarp", ""))',
    'options.get("visualCapture") == true', "else:", 'options.get("_godotInitialScene", "")',
    "quest_manager.accept_quest(initial_quest)", "await scene_manager.load_initial_scene(initial_scene)",
    "await _try_start_initial_prologue(", "if tear_down_complete or not renderer.is_initialized():",
    "main_tick = func(delta: float) -> void:", "set_process(true)", "setup_web_gl_panel_diagnostics()",
    "if dev_startup_route.is_valid():", "var route := dev_startup_route", "dev_startup_route = Callable()",
    "await route.call()", "if tear_down_complete or not renderer.is_initialized():", "runtime_ready = true",
    "setup_runtime_command_polling()", 'await publish_runtime_debug_snapshot("runtime-ready")',
]), "Godot Game.start player/branch/tick/dev-route/ready tail order drift")
normal_start_branch = section(
    game_start,
    "\telse:\n\t\tvar godot_initial_scene",
    "\n\n\tif tear_down_complete or not renderer.is_initialized():",
)
require(ordered_tokens(normal_start_branch, [
    'var godot_initial_scene := str(options.get("_godotInitialScene", "")).strip_edges()',
    'var initial_quest := str(game_config.get("initialQuest", "")).strip_edges()',
    "if godot_initial_scene.is_empty() and not initial_quest.is_empty():",
    "quest_manager.accept_quest(initial_quest)",
    'var initial_scene := godot_initial_scene if not godot_initial_scene.is_empty() else str(game_config.get("initialScene", ""))',
    "await scene_manager.load_initial_scene(initial_scene)", "await _try_start_initial_prologue(",
]), "Godot normal startup quest/scene/prologue or engine-scene override order drift")
require(normal_start_branch.count("quest_manager.accept_quest(") == 1 and "RuntimeDevModeUI.new" not in normal_start_branch,
        "Godot normal startup constructs DEV UI or bypasses the initial-quest override gate")

expected_start_dev_parameters = [
    "playCutscene", "waterPreview", "sugarWheelPreview", "paperCraftPreview",
    "devScene", "narrativeWarp", "visualCapture",
]
ts_start_dev_header = section(game, "private async startDevMode(", "): Promise<void>")
ts_start_dev_parameters = re.findall(r"^\s{4}([A-Za-z_][A-Za-z0-9_]*)\??:", ts_start_dev_header, flags=re.MULTILINE)
require(ts_start_dev_parameters == expected_start_dev_parameters, f"TypeScript startDevMode parameter/order drift: {ts_start_dev_parameters}")
gd_start_dev_mode = gd_function(bootstrap, "start_dev_mode")
gd_start_dev_header = section(gd_start_dev_mode, "func start_dev_mode(", ") -> void:")
gd_start_dev_parameters = re.findall(r"^\t([A-Za-z_][A-Za-z0-9_]*):", gd_start_dev_header, flags=re.MULTILINE)
require(gd_start_dev_parameters == [
    "play_cutscene", "water_preview", "sugar_wheel_preview", "paper_craft_preview",
    "dev_scene", "narrative_warp", "visual_capture",
], f"Godot start_dev_mode parameter/order drift: {gd_start_dev_parameters}")

expected_dev_mode_callbacks = [
    "getCutsceneIds", "playCutscene", "getScenes", "loadScene", "reload",
    "getMinigameEntries", "launchMinigame", "getNarrativeWarps", "enterNarrativeWarp",
]
ts_dev_mode_callback_interface = section(ts_dev_mode_ui, "export interface DevModeCallbacks {", "\n}")
ts_dev_mode_callback_fields = re.findall(r"^\s{2}([A-Za-z_][A-Za-z0-9_]*)\(", ts_dev_mode_callback_interface, flags=re.MULTILINE)
require(ts_dev_mode_callback_fields == expected_dev_mode_callbacks, f"TypeScript DevModeCallbacks surface/order drift: {ts_dev_mode_callback_fields}")
gd_dev_mode_callback_block = section(gd_start_dev_mode, "RuntimeDevModeUI.new(renderer, {", "\n\t})")
gd_dev_mode_callback_fields = re.findall(r'^\t\t"([A-Za-z_][A-Za-z0-9_]*)"\s*:', gd_dev_mode_callback_block, flags=re.MULTILINE)
require(gd_dev_mode_callback_fields == expected_dev_mode_callbacks, f"Godot DevModeUI callback surface/order drift: {gd_dev_mode_callback_fields}")
require(ordered_tokens(gd_start_dev_mode, [
    'const DEV_SCENE := "dev_room"', "await scene_manager.load_scene(DEV_SCENE)",
    "await load_narrative_warps()", "dev_mode_ui = RuntimeDevModeUI.new(renderer, {",
    "if not visual_capture: dev_mode_ui.open()", "var reopen_dev_hub := func() -> void:",
    "if not is_dev_mode: return", "scene_manager.get_current_scene_id() == DEV_SCENE",
    "water_minigame_manager.set_on_session_end(reopen_dev_hub)",
    "sugar_wheel_minigame_manager.set_on_session_end(reopen_dev_hub)",
    "paper_craft_minigame_manager.set_on_session_end(reopen_dev_hub)",
    "dev_startup_route = func() -> void:",
]), "Godot start_dev_mode scene/warp/UI/session/staged-route assembly order drift")
require(gd_start_dev_mode.count("set_on_session_end(") == 3,
        "Godot start_dev_mode must install exactly the three source minigame session-end callbacks")
require(bootstrap.count("RuntimeDevModeUI.new(") == 1 and "RuntimeDevModeUI.new(" in gd_start_dev_mode,
        "Godot DevModeUI must be constructed only inside start_dev_mode")

gd_dev_startup_route = section(gd_start_dev_mode, "\tdev_startup_route = func() -> void:", "\n\n")
require(ordered_tokens(gd_dev_startup_route, [
    "var cutscene_id := play_cutscene.strip_edges()", "await dev_play_cutscene(cutscene_id)",
    "var warp_id := narrative_warp.strip_edges()", "await enter_narrative_warp(warp_id)", "return",
    "var scene_id := dev_scene.strip_edges()", "await dev_load_scene(scene_id)", "return",
    "var water_id := water_preview.strip_edges()", "await water_minigame_manager.start(water_id)", "return",
    "var sugar_id := sugar_wheel_preview.strip_edges()", "await sugar_wheel_minigame_manager.start(sugar_id)", "return",
    "var paper_id := paper_craft_preview.strip_edges()", "await paper_craft_minigame_manager.start(paper_id)",
]), "Godot staged DEV route additive/exclusive priority drift")
require("return" not in section(gd_dev_startup_route, "var cutscene_id", "var warp_id"),
        "Godot staged DEV route made playCutscene exclusive instead of additive")
for branch_start, branch_end in [
    ("var warp_id", "var scene_id"), ("var scene_id", "var water_id"),
    ("var water_id", "var sugar_id"), ("var sugar_id", "var paper_id"),
]:
    require("return" in section(gd_dev_startup_route, branch_start, branch_end),
            f"Godot staged DEV route branch lost exclusivity: {branch_start}")

require(ordered_tokens(game, [
    "private narrativeWarps:", "private devStartupRoute:", "private async loadNarrativeWarps(",
    "private async enterNarrativeWarp(", "private async startDevMode(", "private async devPlayCutscene(",
    "private devReload(", "private getDevSceneIds(", "private async getDevSceneEntries(",
    "private async devLoadScene(",
]), "TypeScript Game DEV cache/method declaration order drift")
require(ordered_tokens(bootstrap, [
    "var narrative_warps: Array = []", "var dev_startup_route := Callable()",
    "func load_narrative_warps(", "func enter_narrative_warp(", "func start_dev_mode(",
    "func get_narrative_warp_entries(", "func _get_dev_minigame_entries(", "func _dev_launch_minigame(",
    "func dev_play_cutscene(", "func dev_reload(", "func get_dev_scene_ids(",
    "func get_dev_scene_entries(", "func dev_load_scene(",
]), "Godot Game DEV cache/method declaration order drift")
gd_enter_narrative_warp = gd_function(bootstrap, "enter_narrative_warp")
require(ordered_tokens(gd_enter_narrative_warp, [
    "for candidate: Variant in narrative_warps:", 'warp.get("flowGraph", "")', 'warp.get("flowState", "")',
    "narrative_state_manager.get_graph(flow_graph)", "var adjacency := {}", 'graph.get("transitions", [])',
    'graph.get("initialState", "")', "var came_from := {}", "var seen := {start: true}",
    "var queue: Array[String] = [start]", "while not queue.is_empty():", "queue.pop_front()",
    "if seen.has(next_state): continue", "came_from[next_state] = current", "queue.push_back(next_state)",
    "if not seen.has(flow_state):", "var path: Array[String] = []", "path.push_front(cursor)",
    "await narrative_state_manager.debug_set_narrative_state(flow_graph, state_id)",
    'for state: Variant in warp.get("set", [])', "await dev_load_scene(",
]), "Godot narrative warp BFS/state/scene chain drift")
gd_dev_scene_ids = gd_function(bootstrap, "get_dev_scene_ids")
gd_dev_scene_entries = gd_function(bootstrap, "get_dev_scene_entries")
gd_dev_load_scene = gd_function(bootstrap, "dev_load_scene")
require(ordered_tokens(gd_dev_scene_ids, [
    "map_ui.get_configured_scene_ids()", 'seen["dev_room"] = true',
    'for key: String in ["initialScene", "fallbackScene"]', "ids.sort()", "return ids",
]), "Godot get_dev_scene_ids source chain drift")
require(ordered_tokens(gd_dev_scene_entries, [
    "for id: String in get_dev_scene_ids()", "asset_manager.load_scene_data(id)",
    'definition.get("name")', 'else id', 'result.push_back({"id": id, "name": name})', "return result",
]), "Godot get_dev_scene_entries source chain drift")
require(ordered_tokens(gd_dev_load_scene, [
    "if scene_id.is_empty() or scene_manager.is_switching(): return", "dev_mode_ui.close()",
    "await scene_manager.switch_scene(scene_id)", "map_ui.set_current_scene(scene_id)",
    'if is_dev_mode and scene_id == "dev_room"', "dev_mode_ui.open()",
]), "Godot dev_load_scene switch/map/dev-hub chain drift")

ts_dev_mode_fields = re.findall(r"^\s{2}private ([A-Za-z_][A-Za-z0-9_]*)(?=\s*(?::|=))", ts_dev_mode_ui, flags=re.MULTILINE)
gd_dev_mode_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_dev_mode_ui, flags=re.MULTILINE)
require(ts_dev_mode_fields == [
    "renderer", "callbacks", "container", "_isOpen", "scrollY", "maxScrollY",
    "contentMask", "contentContainer", "boundWheel", "section",
], f"TypeScript DevModeUI field/order drift: {ts_dev_mode_fields}")
require(gd_dev_mode_fields == [
    "renderer", "callbacks", "container", "_is_open", "scroll_y", "max_scroll_y",
    "content_mask", "content_container", "bound_wheel", "section",
], f"Godot DevModeUI field/order drift: {gd_dev_mode_fields}")
require("extends RefCounted" in gd_dev_mode_ui and "RuntimeTextPanel" not in gd_dev_mode_ui and "extends RuntimeTextPanel" not in gd_dev_mode_ui,
        "Godot DevModeUI retains the non-source TextPanel inheritance/ownership layer")
require('const SECTIONS := ["cutscene", "scene", "minigames", "narrative"]' in gd_dev_mode_ui,
        "Godot DevModeUI four-section identity/order drift")
gd_dev_mode_init = gd_function(gd_dev_mode_ui, "_init")
gd_dev_mode_close = gd_function(gd_dev_mode_ui, "close")
gd_dev_mode_destroy = gd_function(gd_dev_mode_ui, "destroy")
require(ordered_tokens(gd_dev_mode_init, [
    "renderer = next_renderer", "callbacks = next_callbacks", "container = Control.new()",
    "container.visible = false", "renderer.ui_layer.add_child(container)",
]), "Godot DevModeUI constructor no longer mounts one persistent hidden container")
require(ordered_tokens(gd_dev_mode_close, [
    "_is_open = false", "container.visible = false", "clear_children()", "container.gui_input.disconnect(bound_wheel)",
]), "Godot DevModeUI close lifecycle drift")
require(all(token not in gd_dev_mode_close for token in ["container.free()", "container = null", "container.get_parent().remove_child(container)"]),
        "Godot DevModeUI close destroys its persistent container")
require(ordered_tokens(gd_dev_mode_destroy, [
    "close()", "container.get_parent().remove_child(container)", "container.free()", "container = null",
]), "Godot DevModeUI destroy is not the sole persistent-container destruction boundary")
require(gd_dev_mode_ui.count("container.free()") == 1 and "container.free()" in gd_dev_mode_destroy,
        "Godot DevModeUI persistent container has multiple destruction owners")
require(ordered_tokens(ts_dev_mode_ui, [
    "private buildCutsceneList(", "private buildMinigameList(", "private buildNarrativeList(",
    "private buildSceneList(", "private makeListItem(", "private makeButton(",
    "private makeSectionTab(", "private onWheel(", "private applyScroll(",
]), "TypeScript DevModeUI list/scroll method order drift")
require(ordered_tokens(gd_dev_mode_ui, [
    "func build_cutscene_list(", "func build_minigame_list(", "func build_narrative_list(",
    "func build_scene_list(", "func make_list_item(", "func make_button(",
    "func make_section_tab(", "func on_wheel(", "func apply_scroll(",
]), "Godot DevModeUI list/scroll method order drift")

ts_register_ui_panels = section(game, "private registerUIPanels()", "private logDepthDiag")
gd_register_ui_panels = gd_function(bootstrap, "_register_ui_panels")
require("new TouchMobileControls(" in ts_register_ui_panels,
        "TypeScript TouchMobileControls construction escaped registerUIPanels")
require("RuntimeTouchMobileControls.new(renderer, input_manager, state_controller, strings_provider)" in gd_register_ui_panels and
        bootstrap.count("RuntimeTouchMobileControls.new(") == 1,
        "Godot TouchMobileControls must be constructed only in _register_ui_panels")

runtime_command_polling_setup = gd_function(bootstrap, "setup_runtime_command_polling")
require(ordered_tokens(runtime_command_polling_setup, [
    "if runtime_command_bridge != null:", "return", "runtime_command_bridge = RuntimeCommandBridgeScript.new()",
    "runtime_command_bridge.bind(", "add_child(runtime_command_bridge)", "poll_runtime_commands()",
]), "Godot runtime-command bridge polling construction order drift")
require(bootstrap.count("RuntimeCommandBridgeScript.new()") == 1 and
        runtime_command_polling_setup.count("RuntimeCommandBridgeScript.new()") == 1 and
        "RuntimeCommandBridgeScript.new()" not in game_start,
        "Godot runtime-command bridge is constructed outside setup_runtime_command_polling")
for constructor_token in [
    "RuntimeEventBus.new()", "RuntimeFlagStore.new(", "RuntimeStringsProvider.new()", "RuntimeInputManager.new()",
    "RuntimeAssetManager.new()", "RuntimeGameStateController.new(", "RuntimeActionExecutor.new(",
    "RuntimeSceneManager.new(", "RuntimeInventoryManager.new(", "RuntimeRulesManager.new(",
]:
    require(constructor_token not in game_start, f"Godot Game.start still constructs a source constructor-owned object: {constructor_token}")
require(ordered_tokens(game_start, [
    "set_condition_eval_context_factory(condition_factory)", "plane_reconciler.bind_runtime({",
    "document_reveal_manager.set_blend_executor", "document_reveal_manager.load_definitions()",
    "scenario_state_manager.configure_runtime", "narrative_state_manager.load_from_asset",
    "RuntimeActionRegistryScript.register_action_handlers", "pressure_hold_manager.bind_runtime",
    "water_minigame_manager.bind_runtime", "water_minigame_manager.load_index",
    "sugar_wheel_minigame_manager.bind_runtime", "sugar_wheel_minigame_manager.load_index",
    "paper_craft_minigame_manager.bind_runtime", "paper_craft_minigame_manager.load_index",
]), "Godot Game.start condition/plane/narrative/action/minigame order drift")
ts_startup_load_phase = section(game, "await Promise.all([\n      this.loadFlagRegistry()", "]);\n    if (this.tearDownComplete) return;")
gd_startup_load_phase = section(game_start, "\tload_flag_registry()", "\tif tear_down_complete: return")
require(ordered_tokens(ts_startup_load_phase, [
    "this.loadFlagRegistry()", "this.loadCharacterRegistry()", "this.loadSmellProfiles()",
    "this.inventoryManager.loadDefs()", "this.rulesManager.loadDefs()", "this.questManager.loadDefs()",
    "this.encounterManager.loadDefs()", "this.pressureHoldManager.loadDefs()", "this.planeReconciler.loadDefs()",
    "this.signalCueManager.loadDefs()", "this.audioManager.loadConfig()", "this.cutsceneManager.loadDefs()",
    "this.archiveManager.loadDefs()", "this.shopUI.loadDefs()", "this.mapUI.loadConfig()",
]), "TypeScript Game startup definition-load phase/order drift")
require(ordered_tokens(gd_startup_load_phase, [
    "load_flag_registry()", "load_character_registry()", "load_smell_profiles()",
    "inventory_manager.load_defs()", "rules_manager.load_defs()", "quest_manager.load_defs()",
    "encounter_manager.load_defs()", "pressure_hold_manager.load_defs()", "plane_reconciler.load_defs()",
    "signal_cue_manager.load_defs()", "audio_manager.load_config()", "cutscene_manager.load_defs()",
    "archive_manager.load_defs()", "shop_ui.load_defs()", "map_ui.load_config()",
]), "Godot Game startup definition-load phase/order drift")
require(ordered_tokens(game_start, [
    "debug_tools.init()", "load_flag_registry()", "load_character_registry()", "load_smell_profiles()",
    "_refresh_text_resolve_lookups()", "wire_text_resolve()",
]), "Godot Game startup loaders/text wiring are not in source phase order")
gd_loader_methods = section(bootstrap, "func load_flag_registry()", "func _load_game_config()")
require(ordered_tokens(gd_loader_methods, [
    "func load_flag_registry()", 'asset_manager.load_json("/assets/data/flag_registry.json")',
    "flag_store.configure_registry(registry)", "func load_character_registry()",
    'asset_manager.load_json("/assets/data/character_registry.json")',
    "scene_manager.set_character_registry", 'raw.get("characters")', "func load_smell_profiles()",
    'asset_manager.load_json("/assets/data/smell_profiles.json")', "smell_profiles_data = data",
    "hud.set_smell_profiles(data)",
]), "Godot Game independent loader method boundaries/order drift")
for asset_path in ["flag_registry.json", "character_registry.json", "smell_profiles.json"]:
    require(bootstrap.count(asset_path) == 1 and asset_path in gd_loader_methods, f"Godot Game loader asset ownership drift: {asset_path}")
require("RuntimeHUD.new(renderer, event_bus, strings_provider)" in game_start, "Godot Game HUD constructor dependency shape drift")
require("RuntimeHUD.new(renderer, event_bus, strings_provider," not in game_start, "Godot Game constructs HUD with target-only eager smell data")
require("set_active_quests" not in gd_hud and "hud.set_active_quests" not in game_start, "Godot retains target-only HUD quest hydration ownership")
require(ordered_tokens(ts_hud, [
    "private smellRenderer: SmellIndicatorRenderer | null = null", "private smellLast: SmellRenderState =",
    "private smellCb:", "private sniffCb:", "this.smellCb =", "this.smellLast =",
    "this.smellRenderer?.setState(this.smellLast)", "this.sniffCb = () => { this.smellRenderer?.pulseBoost(); }",
    "private stepSmell(dt: number)", "this.smellRenderer?.update(dt)", "setSmellProfiles(data: SmellProfilesRaw)",
    "this.smellRenderer.destroy()", "new SmellIndicatorRenderer(this.container, data, { x: 34, y: 160 })",
    "this.smellRenderer.setState(this.smellLast)", "getSmellForm()", "setSmellFormParam(",
]), "TypeScript HUD deferred smell-renderer ownership/order drift")
require(ordered_tokens(gd_hud, [
    "var smell: RuntimeSmellIndicatorRenderer = null", "var smell_last :=",
    "func _init(next_renderer: RuntimeRenderer, event_bus: RuntimeEventBus, next_strings: RuntimeStringsProvider)",
    "func set_smell_profiles(data: Dictionary)", "smell.destroy()",
    "RuntimeSmellIndicatorRenderer.new(root, data, Vector2(34, 160))", "smell.set_state(smell_last)",
    "func get_smell_form()", "func set_smell_form_param(",
]), "Godot HUD asynchronous smell-renderer ownership/order drift")
require("if smell != null:\n\t\tsmell.update(dt)" in gd_hud and "if smell != null:\n\t\tsmell.pulse_boost()" in gd_hud,
        "Godot HUD does not preserve source optional smell-renderer update/sniff semantics")
require("var fixed_tick_mode := false" in gd_hud, "Godot HUD lost source fixed-tick clock ownership")
require(ordered_tokens(gd_function(gd_hud, "update"), [
    "if fixed_tick_mode:", "return", "_step_visuals(dt)",
]), "Godot HUD normal/fixed clock split drift")
require(ordered_tokens(gd_function(gd_hud, "set_fixed_tick_mode"), [
    "if fixed_tick_mode == enabled:", "return", "fixed_tick_mode = enabled",
    "if enabled:", "reset_animation_clock()",
]), "Godot HUD setFixedTickMode state/reset order drift")
require(ordered_tokens(gd_function(gd_hud, "step_fixed_tick"), [
    "if not fixed_tick_mode:", "return", "_step_visuals(dt)",
]), "Godot HUD stepFixedTick gate/clock drift")
require(ordered_tokens(game_start, [
    "map_ui.load_config()", "await RuntimeMicrotaskQueueScript.yield_turn()", "if tear_down_complete: return",
    "_refresh_text_resolve_lookups()", "await RuntimeMicrotaskQueueScript.yield_turn()",
    "if tear_down_complete: return", "wire_text_resolve()",
]), "Godot Game startup load/text-resolution barrier drift")
ts_npc_runtime_apply = section(game, "private async applyNpcRuntimeFieldNow(", "private async reloadNpcSpriteFromDef(")
gd_npc_runtime_apply = section(bootstrap, "func _apply_npc_runtime_field_now(", "func _apply_hotspot_runtime_field_now(")
require(ordered_tokens(ts_npc_runtime_apply, [
    "fieldName === 'patrolDisabled'", "if (value) this.stopNpcPatrol(npcId)",
    "else this.startNpcPatrolForNpc(npcId)",
]), "TypeScript Game patrolDisabled runtime-field restart contract drift")
require(ordered_tokens(gd_npc_runtime_apply, [
    '"patrolDisabled":', "if value: stop_npc_patrol(npc_id)",
    "else: _start_npc_patrol_for_npc(npc_id)",
]), "Godot Game patrolDisabled runtime-field restart contract drift")
require(ordered_tokens(bootstrap, [
    "func stop_npc_patrol(", "func _start_npc_patrol_for_npc(", "stop_npc_patrol(id)", "_run_npc_patrol(",
]), "Godot Game patrol stop/restart method ownership/order drift")
require('"startNpcPatrol": Callable(self, "_start_npc_patrol_for_npc")' in game_start,
        "Godot ActionRegistry startNpcPatrol dependency bypasses Game restart boundary")
require(ordered_tokens(game_start, ["set_process(true)", "runtime_ready = true", "setup_runtime_command_polling()"]), "Godot Game.start tick/ready/runtime-command tail order drift")

require(ordered_tokens(ts_hold_progress, [
    "private ratio", "private readonly cfg", "constructor(", "get current", "get reachedStop", "tick(",
    "export function clamp01(", "export function validateInterruptRatios(", "export function validateInterruptChain(",
]), "TypeScript HoldProgress field/method architecture drift")
require(ordered_tokens(gd_hold_progress, [
    "var ratio", "var cfg", "var current", "var reached_stop", "func _init(", "func tick(",
    "static func clamp01(", "static func validate_interrupt_ratios(", "static func validate_interrupt_chain(",
]), "Godot HoldProgress field/method architecture/order drift")
require("RuntimeHoldProgress.validate_interrupt_chain(interrupts)" in gd_pressure_hold_manager, "Godot PressureHoldManager duplicates holdProgress interrupt-chain ownership")
require("var progress := RuntimeHoldProgress.new({" in gd_pressure_hold_ui, "Godot PressureHoldUI does not construct the translated HoldProgress class")
require("progress.tick(dt, holding)" in gd_pressure_hold_ui and "progress.reached_stop" in gd_pressure_hold_ui, "Godot PressureHoldUI bypasses translated HoldProgress tick/stop ownership")
for duplicated_hold_formula in [
    "current_ratio + dt / float(request.fillSeconds)",
    "current_ratio - dt * float(request.decayPerSecond)",
]:
    require(duplicated_hold_formula not in gd_pressure_hold_ui, f"Godot PressureHoldUI retains duplicate HoldProgress formula: {duplicated_hold_formula}")

require(ordered_tokens(ts_dev_error_overlay, [
    "let container", "let listEl", "const seen", "function ensureOverlay(",
    "export function reportDevError(", "export function describeError(", "export function clearDevErrors(",
]), "TypeScript devErrorOverlay field/function architecture drift")
require(ordered_tokens(gd_dev_error_overlay, [
    "static var container", "static var list_el", "static var seen", "static func _ensure_overlay(",
    "static func report_dev_error(", "static func describe_error(", "static func clear_dev_errors(",
]), "Godot DevErrorOverlay field/function architecture/order drift")
require("existing.count = int(existing.count) + 1" in gd_dev_error_overlay and 'existing.row.text = "×%s  %s"' in gd_dev_error_overlay, "Godot DevErrorOverlay lost duplicate-message folding")
require("OS.is_debug_build()" in gd_dev_error_overlay and "push_error(console_tag + \" \" + message)" in gd_dev_error_overlay, "Godot DevErrorOverlay lost dev-only console-first reporting")
require('DisplayServer.get_name() == "headless"' in gd_dev_error_overlay, "Godot DevErrorOverlay does not preserve source no-DOM/headless fallback")
require(ordered_tokens(ts_depth_log, ["export function depthLog(", "export function depthError(", "reportDevError(msg)"]), "TypeScript depthLog function/call architecture drift")
require(ordered_tokens(gd_depth_log, ["static func depth_log(", "static func depth_error(", "RuntimeDevErrorOverlay.report_dev_error(message)"]), "Godot DepthLog function/call architecture drift")
require("RuntimeDevErrorOverlay.report_dev_error(\"[%s] 加载失败:" in gd_asset_manager, "Godot AssetManager lost source devErrorOverlay load-failure call")
require("RuntimeDevErrorOverlay.report_dev_error(" in action_executor and "数据引用了未注册的动作类型" in action_executor, "Godot ActionExecutor lost source devErrorOverlay unknown-action call")
require("RuntimeDepthLog.depth_log(\"DepthSystem\"" in scene_depth and "RuntimeDepthLog.depth_error(\"DepthSystem\"" in scene_depth, "Godot SceneDepthSystem bypasses translated depthLog/depthError")

require(ordered_tokens(ts_debug_tools, [
    "private deps", "private positionDebugMode", "private positionDebugKeyHandler", "private positionDebugPointerHandler",
    "private debugMarker", "private sceneUnloadCb", "private debugMiddleButtonCameraZoomEnabled",
    "private middleZoomDragActive", "private middleZoomLastY", "private middleZoomPointerId",
    "private cameraZoomWheelHandler", "private middleZoomPointerDownHandler", "private middleZoomPointerMoveHandler",
    "private middleZoomPointerUpHandler", "private hudHealthDebugOverrideEnabled", "private hudHealthDebugOverrideRatio",
    "private smellDebugScent", "private smellDebugIntensity", "private smellDebugDir", "private smellDebugFlicker",
    "private smellDebugLayer", "constructor(", "init():", "private clearDebugMarker(", "private clampDebugCameraZoom(",
    "private normalizeWheelDeltaY(", "private isEventOnCanvas(", "private setupMiddleButtonCameraZoom(",
    "update(_dt:", "private setupPositionDebugTool(", "private buildScenarioDebugListExtra(",
    "private emitHudHealthDebugOverride(", "private clampUnitValue(", "private applySmellDebug(",
    "private buildSmellDebugSection(", "private setupDebugPanelSections(", "destroy():",
]), "TypeScript DebugTools field/method architecture drift")
require(ordered_tokens(gd_debug_tools, [
    "var _deps", "var _position_debug_mode", "var _position_debug_key_handler", "var _position_debug_pointer_handler",
    "var _debug_marker", "var _scene_unload_cb", "var _debug_middle_button_camera_zoom_enabled",
    "var _middle_zoom_drag_active", "var _middle_zoom_last_y", "var _middle_zoom_pointer_id",
    "var _camera_zoom_wheel_handler", "var _middle_zoom_pointer_down_handler", "var _middle_zoom_pointer_move_handler",
    "var _middle_zoom_pointer_up_handler", "var _hud_health_debug_override_enabled", "var _hud_health_debug_override_ratio",
    "var _smell_debug_scent", "var _smell_debug_intensity", "var _smell_debug_dir", "var _smell_debug_flicker",
    "var _smell_debug_layer", "func _init(", "func init(", "func _clear_debug_marker(",
    "func _clamp_debug_camera_zoom(", "func _normalize_wheel_delta_y(", "func _is_event_on_canvas(",
    "func _setup_middle_button_camera_zoom(", "func update(", "func _setup_position_debug_tool(",
    "func _build_scenario_debug_list_extra(", "func _emit_hud_health_debug_override(",
    "func _clamp_unit_value(", "func _apply_smell_debug(", "func _build_smell_debug_section(",
    "func _setup_debug_panel_sections(", "func _narrative_section(", "func _quick_actions_section(",
    "func _hud_health_section(", "func _collisions_section(", "func _background_debug_section(",
    "func _depth_occlusion_section(", "func _entity_shadow_section(", "func _scene_world_size_section(",
    "func _pixel_density_section(", "func _camera_section(", "func destroy(",
]), "Godot DebugTools field/method architecture/order drift")

ts_debug_interface_deps = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+):", section(ts_debug_tools, "export interface DebugToolsDeps", "export class DebugTools"), flags=re.MULTILINE)
ts_debug_wiring = section(game, "if (import.meta.env.DEV) this.debugTools = new DebugTools({", "this.debugTools?.init()")
ts_debug_deps = re.findall(r"^\s{6}([A-Za-z][A-Za-z0-9]+):", ts_debug_wiring, flags=re.MULTILINE)
gd_debug_wiring = section(bootstrap, "debug_tools = RuntimeDebugTools.new({", "debug_tools.name = \"DebugTools\"")
gd_debug_deps = re.findall(r'^\t{3}"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_debug_wiring, flags=re.MULTILINE)
require(set(ts_debug_deps) == set(ts_debug_interface_deps), f"TypeScript Game DebugTools wiring/interface drift: interface={ts_debug_interface_deps} wiring={ts_debug_deps}")
require(ts_debug_deps == gd_debug_deps, f"DebugTools constructor dependency shape/order drift: TS={ts_debug_deps} Godot={gd_debug_deps}")
ts_smell_deps = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+):", section(ts_debug_tools, "export interface SmellDebugController", "/** 调试缩放下限"), flags=re.MULTILINE)
gd_smell_block = section(gd_debug_wiring, '"smellDebug": {', "\n\t\t\t},")
gd_smell_deps = re.findall(r'^\t{4}"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_smell_block, flags=re.MULTILINE)
require(ts_smell_deps == gd_smell_deps, f"DebugTools smell dependency shape/order drift: TS={ts_smell_deps} Godot={gd_smell_deps}")

def debug_section_ids(text: str, marker: str, quote: str) -> list[str]:
    pattern = rf"{marker}\((NARRATIVE_DEBUG_SECTION_ID|{quote}([^{quote}]+){quote})"
    return ["叙事调试" if match[0] == "NARRATIVE_DEBUG_SECTION_ID" else match[1] for match in re.findall(pattern, text)]

ts_debug_sections = debug_section_ids(ts_debug_tools, "debugPanelUI.addSection", "'")
gd_debug_sections = debug_section_ids(gd_debug_tools, "debug_panel.add_section", '"')
require(ts_debug_sections == gd_debug_sections and len(ts_debug_sections) == 11, f"DebugTools section registration/order drift: TS={ts_debug_sections} Godot={gd_debug_sections}")
require(ordered_tokens(bootstrap, [
    "func setup_cutscene_step_hud()", 'debug_panel_ui.add_section("cutscene-step"',
    "func setup_plane_debug_section()", 'debug_panel_ui.add_section("位面"',
]), "Godot Game lost source-owned cutscene/plane DebugPanel sections")
require(all(token in gd_debug_panel for token in ['value.get("actions")', 'source.get("noRefresh")', 'value.get("extra")', "extra is Control"]), "Godot DebugPanelUI does not consume the source actions/noRefresh/extra section contract")
require("func get_smell_form(" in gd_hud and "func set_smell_form_param(" in gd_hud, "Godot HUD does not expose the source DebugTools smell-form dependency surface")
require("func apply_debug_world_size(" in scene_manager and "func get_background_texels_per_world(" in scene_manager, "Godot SceneManager lacks DebugTools world-size/background-density counterparts")
require("background_resample" not in scene_manager and "image.material" not in scene_manager, "Godot SceneManager invents a background resample material absent from the source Sprite translation")
require("world_container = CanvasGroup.new()" in gd_renderer and "background_layer = Node2D.new()" in gd_renderer, "Godot Renderer must keep one world-filter CanvasGroup without the white-rendering nested CanvasGroup topology")
require("if (import.meta.env.DEV) this.debugTools = new DebugTools" in game and "if OS.is_debug_build():\n\t\tdebug_tools = RuntimeDebugTools.new" in bootstrap, "DebugTools development-build gate drift")
require('"isDevMode": func() -> bool: return is_dev_mode' in gd_debug_wiring and
        'is_dev_mode = bool(options.get("devMode", false))' in game_start,
        "Godot DebugTools isDevMode dependency is not backed by GameStartOptions-owned startup state")

require(ordered_tokens(ts_depth_debug_visualizer, [
    "private depthSystem", "private camera", "private renderer", "private assetManager", "private filter",
    "private filterAttached", "private currentMode", "private collisionTextureLoaded", "private currentSceneId",
    "private collisionMapName", "private sceneW", "private sceneH", "private readonly panelLog", "constructor(",
    "get mode", "setMode(", "onSceneLoaded(", "updateSceneWorldSize(", "onSceneUnloaded(",
    "loadCollisionTexture(", "update():", "attachFilter(", "detachFilter(", "destroy():",
]), "TypeScript DepthDebugVisualizer field/method architecture drift")
require(ordered_tokens(gd_depth_debug_visualizer, [
    "var _depth_system", "var _camera", "var _renderer", "var _asset_manager", "var _filter",
    "var _filter_attached", "var _current_mode", "var _collision_texture_loaded", "var _current_scene_id",
    "var _collision_map_name", "var _scene_w", "var _scene_h", "var _panel_log", "func _init(",
    "var mode", "func set_mode(", "func on_scene_loaded(", "func update_scene_world_size(",
    "func on_scene_unloaded(", "func _load_collision_texture(", "func update(", "func _attach_filter(",
    "func _detach_filter(", "func destroy(",
]), "Godot DepthDebugVisualizer field/method architecture/order drift")
require("RuntimeDepthDebugVisualizer.new(scene_depth_system, camera, renderer, asset_manager" in bootstrap, "Godot Game does not construct DepthDebugVisualizer with source dependencies/order")
for source in ["src/debug/debugPanelRuntimeLog.ts", "src/debug/webglPanelDiagnostics.ts"]:
    entries = [entry for entry in translation_modules if entry.get("source") == source]
    require(len(entries) == 1 and entries[0].get("status") == "browser-platform-only" and entries[0].get("target") is None, f"browser-only debug module classification drift: {source}")

require(ordered_tokens(ts_depth_occlusion_filter, [
    "warmUpDepthOcclusionGlProgramForDiagnostics(", "export class DepthOcclusionFilter", "readonly _isDepthOcclusion",
    "private constructor(", "static createForEntity(", "private get _du", "setSceneSize(",
    "setWorldContainerPos(", "setProjectionScale(", "setWorldToPixel(", "setEntityFootY(",
    "setTolerance(", "setFloorOffset(", "setFloorOffsetExtra(", "setDebug(",
    "setCollisionTexture(", "setOcclusionBlendFactor(",
]), "TypeScript DepthOcclusionFilter module/class/method order drift")
require(ordered_tokens(gd_depth_occlusion_filter, [
    "var _is_depth_occlusion", "var material:", "func _init(",
    "static func warm_up_depth_occlusion_gl_program_for_diagnostics(", "static func create_for_entity(",
    "func set_scene_size(", "func set_world_container_pos(", "func set_projection_scale(",
    "func set_world_to_pixel(", "func set_entity_foot_y(", "func set_tolerance(",
    "func set_floor_offset(", "func set_floor_offset_extra(", "func set_debug(",
    "func set_collision_texture(", "func set_occlusion_blend_factor(",
]), "Godot DepthOcclusionFilter class/method order drift")
gd_depth_constructor = gd_function(gd_depth_occlusion_filter, "_init")
require(ordered_tokens(gd_depth_constructor, [
    'cfg.get("depth_mapping"', 'cfg.get("shader"', 'cfg.get("M"', 'cfg.get("collision"',
    'material.set_shader_parameter("scene_size"', 'material.set_shader_parameter("projection_scale"',
    'material.set_shader_parameter("world_to_pixel_x"', 'material.set_shader_parameter("world_to_pixel_y"',
    'material.set_shader_parameter("depth_invert"', 'material.set_shader_parameter("depth_scale"',
    'material.set_shader_parameter("depth_offset"', 'material.set_shader_parameter("depth_per_sy"',
    'material.set_shader_parameter("floor_a"', 'material.set_shader_parameter("floor_b"',
    'material.set_shader_parameter("floor_offset"', 'material.set_shader_parameter("floor_offset_extra"',
    'material.set_shader_parameter("tolerance"', 'material.set_shader_parameter("world_container_pos"',
    'material.set_shader_parameter("entity_foot_world_y"', 'material.set_shader_parameter("debug_mode"',
    'material.set_shader_parameter("occlusion_blend_factor"', 'material.set_shader_parameter("matrix_ppu"',
    'material.set_shader_parameter("matrix_row0"', 'material.set_shader_parameter("matrix_row2"',
    'material.set_shader_parameter("collision_x_min"', 'material.set_shader_parameter("collision_grid_height"',
    'material.set_shader_parameter("depth_map", depth_texture)',
    'material.set_shader_parameter("collision_map", depth_texture)',
]), "Godot DepthOcclusionFilter constructor/config/uniform translation drift")
require(all(token in gd_depth_occlusion_shader for token in [
    "uniform sampler2D screen_texture", "uniform float canvas_group_target",
    "canvas_group_target > 0.5", "COLOR * textureLod(screen_texture, SCREEN_UV, 0.0)",
    "canvas_group_target < 0.5 && pixel_blur_strength > 0.0001",
    "FRAGCOORD.x - world_container_pos.x", "FRAGCOORD.y - world_container_pos.y",
    "world_x / scene_size.x", "world_y / scene_size.y",
    "entity_foot_world_y * world_to_pixel_y", "depth_per_sy * (pixel_sy - foot_sy)",
    "scene_depth + tolerance < sprite_depth", "dot(matrix_row0", "dot(matrix_row2",
    "texture(collision_map", "color.a *= occlusion_blend_factor",
]), "Godot DepthOcclusionFilter shader lost source screen/depth/debug/collision semantics")
require(all(token not in gd_depth_occlusion_shader for token in ["entity_world_size", "entity_facing", "entity_foot_x"]),
        "Godot DepthOcclusionFilter still reconstructs world position from a target-only entity box")
require(ordered_tokens(gd_function(gd_depth_occlusion_filter, "attach"), [
    "target == null or material == null", "return", 'material.set_shader_parameter("canvas_group_target",',
    "target is CanvasGroup", "target.material = material",
]), "Godot DepthOcclusionFilter attach lost Sprite2D/CanvasGroup engine-target selection")

require(ordered_tokens(ts_entity_lighting_filter, [
    "export interface IEntityShadingFilter", "export interface EntityLightingFilterOptions",
    "export class EntityLightingFilter", "readonly _isDepthOcclusion", "private constructor(",
    "static createForEntity(", "private get _lu", "setSceneSize(", "setWorldToPixel(",
    "setProjectionScale(", "setWorldContainerPos(", "setEntityFootY(", "setEntityFootX(",
    "setFloorOffset(", "setFloorOffsetExtra(", "setTolerance(", "setOcclusionBlendFactor(",
    "setTone(", "setAO(", "setKeyLight(", "setAmbient(", "setDebug(", "setCollisionTexture(",
]), "TypeScript EntityLightingFilter interface/options/class/method order drift")
require(ordered_tokens(gd_entity_lighting_filter, [
    "var _is_depth_occlusion", "var material:", "func _init(", "static func create_for_entity(",
    "func set_scene_size(", "func set_world_to_pixel(", "func set_projection_scale(",
    "func set_world_container_pos(", "func set_entity_foot_y(", "func set_entity_foot_x(",
    "func set_floor_offset(", "func set_floor_offset_extra(", "func set_tolerance(",
    "func set_occlusion_blend_factor(", "func set_tone(", "func set_ao(",
    "func set_key_light(", "func set_ambient(", "func set_debug(", "func set_collision_texture(",
]), "Godot EntityLightingFilter class/method order drift")
gd_lighting_constructor = gd_function(gd_entity_lighting_filter, "_init")
require(ordered_tokens(gd_lighting_constructor, [
    'options.get("cfg")', 'options.get("depthTexture")', 'options.get("probeSource")',
    'options.get("lightEnv")', 'options.get("sampleLiftWorld"',
    "cfg is Dictionary and depth_texture is Texture2D", 'cfg.get("depth_mapping"', 'cfg.get("shader"',
    'light_env.get("key"', 'light_env.get("ambient"', 'light_env.get("ao"',
    'material.set_shader_parameter("scene_size"', 'material.set_shader_parameter("projection_scale"',
    'material.set_shader_parameter("world_to_pixel_x"', 'material.set_shader_parameter("world_to_pixel_y"',
    'material.set_shader_parameter("world_container_pos"', 'material.set_shader_parameter("entity_foot_world_x"',
    'material.set_shader_parameter("entity_foot_world_y"', 'material.set_shader_parameter("sample_lift_world"',
    'material.set_shader_parameter("depth_enabled"', 'material.set_shader_parameter("depth_invert"',
    'material.set_shader_parameter("depth_scale"', 'material.set_shader_parameter("depth_offset"',
    'material.set_shader_parameter("depth_per_sy"', 'material.set_shader_parameter("floor_a"',
    'material.set_shader_parameter("floor_b"', 'material.set_shader_parameter("floor_offset"',
    'material.set_shader_parameter("floor_offset_extra"', 'material.set_shader_parameter("tolerance"',
    'material.set_shader_parameter("occlusion_blend_factor"', 'material.set_shader_parameter("debug_mode"',
    'material.set_shader_parameter("key_color"', 'material.set_shader_parameter("key_intensity"',
    'material.set_shader_parameter("ambient_color"', 'material.set_shader_parameter("ambient_intensity"',
    'material.set_shader_parameter("tone_strength"', 'material.set_shader_parameter("ao_contact"',
    'material.set_shader_parameter("ao_form"', 'material.set_shader_parameter("depth_map"',
    'material.set_shader_parameter("probe_map"',
]), "Godot EntityLightingFilter source-option/default/uniform constructor translation drift")
require(all(token in gd_entity_lighting_shader for token in [
    "uniform sampler2D screen_texture", "uniform float canvas_group_target",
    "canvas_group_target > 0.5", "COLOR * textureLod(screen_texture, SCREEN_UV, 0.0)",
    "canvas_group_target < 0.5 && pixel_blur_strength > 0.0001",
    "FRAGCOORD.x - world_container_pos.x", "FRAGCOORD.y - world_container_pos.y",
    "depth_enabled > 0.5", "mapped_depth + tolerance < sprite_depth",
    "entity_foot_world_x / max(scene_size.x", "entity_foot_world_y - sample_lift_world",
    "texture(probe_map", "irradiance * ambient_intensity + key_color * (key_intensity * 0.5)",
    "ao_contact * smoothstep(0.78, 1.0, local_y)", "ao_form * local_y",
]), "Godot EntityLightingFilter shader lost source screen/depth/tone/AO semantics")
require(all(token not in gd_entity_lighting_shader for token in ["entity_world_size", "entity_facing", "entity_lighting_enabled"]),
        "Godot EntityLightingFilter retains target-only position or class-mode reconstruction")
require(ordered_tokens(gd_function(gd_entity_lighting_filter, "attach"), [
    "target == null or material == null", "return", 'material.set_shader_parameter("canvas_group_target",',
    "target is CanvasGroup", "target.material = material",
]), "Godot EntityLightingFilter attach lost Sprite2D/CanvasGroup engine-target selection")
require("static func create_depth_filter" not in scene_depth_filter_adapter and
        "static func create_lighting_filter" not in scene_depth_filter_adapter and
        "static func _options" not in scene_depth_filter_adapter and
        "static func build_probe_texture" in scene_depth_filter_adapter,
        "Godot irradiance-probe adapter still flattens/constructs source shading-filter classes")
require(ordered_tokens(gd_entity_shading_filters_test, [
    "RuntimeDepthOcclusionFilter.create_for_entity", "not depth.has_method(\"set_entity_foot_x\")",
    "RuntimeEntityLightingFilter.create_for_entity", '"depthTexture": depth_texture',
    '"cfg": cfg', '"probeSource": probe_texture', '"lightEnv": light_env',
    "RenderingServer.force_draw(true)", "rendered.r > 0.9", "var group := CanvasGroup.new()",
    "group_filter.attach(group)", 'get_shader_parameter("canvas_group_target") == 1.0',
    "CanvasGroup entity filter must sample the translated outer-container pass",
    "depth.destroy()", "lighting.destroy()",
]), "DepthOcclusion/EntityLighting lost direct-class/uniform/GPU regression coverage")
require('("res://tests/entity_shading_filters_test.gd", "DepthOcclusion/EntityLighting direct-class/uniform/shader test: PASS")' in run_tests,
        "DepthOcclusion/EntityLighting regression test is not registered in the mandatory Godot suite")

require(ordered_tokens(ts_scene_depth, [
    "private enabled", "private config", "private depthTexture", "private collisionData", "private collisionTexture",
    "private collisionW", "private collisionH", "private filters", "private shadows", "private lightingEnabled",
    "private probeSource", "private lightEnv", "private _depthTolerance", "private _floorOffset",
    "private _occlusionBlendFactor", "private R00", "private R01", "private R02", "private R10", "private R11",
    "private R12", "private R20", "private R21", "private R22", "private ppu", "private cx", "private cy",
    "private colXMin", "private colZMin", "private colCellSize", "private colHeightOffset", "private floorA",
    "private floorB", "private sceneW", "private sceneH", "private sceneId", "private worldToPixelX",
    "private worldToPixelY", "get depthTolerance", "set depthTolerance", "get floorOffset", "set floorOffset",
    "get occlusionBlendFactor", "set occlusionBlendFactor", "registerShadow(", "unregisterShadow(",
    "broadcastDepthParamsToShadows(", "init(", "update(", "serialize(", "deserialize(", "get isEnabled",
    "get isActive", "get isLightingEnabled", "get currentLightEnv", "get currentConfig", "get currentDepthTexture",
    "get currentSceneId", "async load(", "applyRuntimeSceneSize(", "loadDefault(", "unload(", "enableLighting(",
    "disableLighting(", "getShadowSceneContext(", "loadCollisionBitmap(", "isCollision(", "createFilterForEntity(",
    "createLightingFilterForEntity(", "removeFilter(", "setCollisionTextureOnFilters(", "setDebugOnFilters(",
    "applyShadowFilterToneAO(", "applyKeyAmbient(", "private _lastFootLogMs", "updatePerFrame(",
    "updateEntityDepthOcclusion(", "destroy(",
]), "TypeScript SceneDepthSystem field/method architecture drift")
require(ordered_tokens(scene_depth, [
    "var enabled", "var config", "var depth_texture", "var collision_data", "var collision_texture", "var collision_w",
    "var collision_h", "var filters", "var shadows", "var lighting_enabled", "var probe_source", "var light_env",
    "var _depth_tolerance", "var _floor_offset", "var _occlusion_blend_factor", "var r00", "var r01", "var r02",
    "var r10", "var r11", "var r12", "var r20", "var r21", "var r22", "var ppu", "var cx", "var cy",
    "var col_x_min", "var col_z_min", "var col_cell_size", "var col_height_offset", "var floor_a", "var floor_b",
    "var scene_w", "var scene_h", "var scene_id", "var world_to_pixel_x", "var world_to_pixel_y",
    "var depth_tolerance", "var floor_offset", "var occlusion_blend_factor", "func register_shadow(",
    "func unregister_shadow(", "func _broadcast_depth_params_to_shadows(", "func init(", "func update(",
    "func serialize(", "func deserialize(", "var is_enabled", "var is_active", "var is_lighting_enabled",
    "var current_light_env", "var current_config", "var current_depth_texture", "var current_scene_id", "func load(",
    "func apply_runtime_scene_size(", "func load_default(", "func unload(", "func enable_lighting(",
    "func disable_lighting(", "func get_shadow_scene_context(", "func load_collision_bitmap(", "func is_collision(",
    "func create_filter_for_entity(", "func create_lighting_filter_for_entity(", "func remove_filter(",
    "func set_collision_texture_on_filters(", "func set_debug_on_filters(", "func apply_shadow_filter_tone_ao(",
    "func apply_key_ambient(", "var _last_foot_log_ms", "func update_per_frame(",
    "func update_entity_depth_occlusion(", "func destroy(",
]), "Godot SceneDepthSystem field/method architecture/order drift")
for forbidden_scene_depth_member in [
    "var asset_manager", "var collision_image", "var scene_size", "var world_to_pixel:", "var debug_mode",
    "var light_curve", "var pixel_density_match_enabled", "var _lighting_config", "var _plane_light_override",
    "var _records", "var _shadow_records", "var _destroyed", "func load_scene(", "func reset_floor_offset(",
    "func apply_light_env_override(", "func update_sprite_entity(", "func update_hotspot_sprite(",
    "func update_entity_shadow(", "func finish_entity_frame(", "func update_light_env_from_curve(",
]:
    require(forbidden_scene_depth_member not in scene_depth, f"Godot SceneDepthSystem retains non-source Game/adapter ownership: {forbidden_scene_depth_member}")
require("RuntimeDepthOcclusionFilter.create_for_entity(depth_texture, config)" in scene_depth and
        "RuntimeEntityLightingFilter.create_for_entity({" in scene_depth and
        '"depthTexture": depth_texture if enabled else null' in scene_depth and
        '"cfg": config if enabled else null' in scene_depth and
        '"probeSource": probe_source' in scene_depth and '"lightEnv": light_env' in scene_depth and
        '"sampleLiftWorld": sample_lift_world' in scene_depth,
        "Godot SceneDepthSystem does not construct the two source filter classes directly")
require(ordered_tokens(gd_function(scene_depth, "update_entity_depth_occlusion"), [
    "filter.set_entity_foot_y(foot_world_y)", 'filter.has_method("set_entity_foot_x")',
    "filter.set_entity_foot_x(foot_world_x)", "filter.set_floor_offset_extra(floor_offset_extra)",
]), "Godot SceneDepthSystem lost source optional setEntityFootX dispatch")
require('filter.has_method("set_tone")' in gd_function(scene_depth, "apply_shadow_filter_tone_ao") and
        'filter.has_method("set_ao")' in gd_function(scene_depth, "apply_shadow_filter_tone_ao") and
        'filter.has_method("set_key_light")' in gd_function(scene_depth, "apply_key_ambient") and
        'filter.has_method("set_ambient")' in gd_function(scene_depth, "apply_key_ambient"),
        "Godot SceneDepthSystem lost source optional lighting-filter setter dispatch")
require("filter.material.set_shader_parameter" not in scene_depth, "Godot SceneDepthSystem owns engine-specific ShaderMaterial uniforms")
require("static func attach(" in scene_entity_filter_binding and "set_meta(META_KEY, filter)" in scene_entity_filter_binding, "Godot CanvasItem filter binding adapter is incomplete")
require(not (ROOT / "godot_port/scripts/rendering/shadow_scene_context_adapter.gd").exists() and
        "RuntimeShadowSceneContextAdapter" not in bootstrap,
        "Godot retains a target-only adapter around the already source-shaped ShadowSceneContext")

for source_name, source_text, target_name, target_text in [
    ("Player", ts_player, "RuntimePlayer", gd_player),
    ("Npc", ts_npc, "RuntimeNpc", gd_npc),
]:
    require("moveAnimState?: string" in source_text and "faceTowardMovement?: boolean" in source_text, f"TypeScript {source_name}.moveTo optional-parameter contract drift")
    require("func move_to(target_x: float, target_y: float, speed: float, move_anim_state: Variant = null, face_toward_movement: Variant = null)" in target_text, f"Godot {target_name}.move_to lost TypeScript optional/null parameter semantics")
    require("move_anim_state.strip_edges() if move_anim_state is String else \"\"" in target_text, f"Godot {target_name}.move_to does not normalize optional moveAnimState like TypeScript")
    require("face_toward_movement == true" in target_text, f"Godot {target_name}.move_to does not preserve strict-true faceTowardMovement semantics")

require("await Engine.get_main_loop().process_frame" not in section(gd_player, "func move_to(", "func cutscene_update("), "Godot RuntimePlayer.move_to adds a frame after source Promise completion")
require("await Engine.get_main_loop().process_frame" not in section(gd_npc, "func move_to(", "func begin_move_to("), "Godot RuntimeNpc.move_to adds a frame after source Promise completion")

ts_avatar_methods = section(game, "private async buildAnimationManifestRefs(", "/**\n   * 热区 / 图对话 Action：停止指定 NPC")
gd_avatar_methods = section(bootstrap, "func build_animation_manifest_refs(", "func build_runtime_debug_snapshot(")
require(ordered_tokens(ts_avatar_methods, [
    "private async buildAnimationManifestRefs(", "private async loadPlayerAvatarResources(",
    "private placeholderPlayerAvatar()", "private currentPlayerPortraitSlug", "private static portraitSlugFromManifest(",
    "private mountPlayerAvatar(", "async applyPlayerAvatarFromAction(", "async resetPlayerAvatarFromAction(",
    "private async setupPlayer(",
]), "TypeScript Game avatar method architecture/order drift")
require(ordered_tokens(gd_avatar_methods, [
    "func build_animation_manifest_refs(", '"type": "json"', '"label": "%s清单"',
    "func load_player_avatar_resources(", "RuntimeAnimationSetResolverScript.normalize_animation_set_def(",
    "RuntimePlaceholderFactoryScript.create_placeholder_player_textures(renderer)",
    "func placeholder_player_avatar()", '"cols": 6', '"idle": {"frames": [0, 1], "frameRate": 2',
    '"walk": {"frames": [2, 3, 4, 5], "frameRate": 8',
    '"run": {"frames": [2, 3, 4, 5], "frameRate": 12',
    "static func portrait_slug_from_manifest(", "func mount_player_avatar(",
    "current_player_portrait_slug =", "player_anim_def = anim_def", "player.sprite.load_from_def(",
    "player.sprite.set_logical_state_map(", 'player.sprite.play_animation("idle")',
    "func apply_player_avatar_from_action(", "func reset_player_avatar_from_action(", "func setup_player(",
    '"scopeId": "startup:player"', '"mode": "runtime"', "tear_down_complete",
    "renderer.is_initialized()", '"mode": "stage"', "renderer.entity_layer.add_child(player.sprite)",
    "var player_position_getter :=", "interaction_system.set_player_position_getter(player_position_getter)",
    "zone_system.set_player_position_getter(player_position_getter)",
]), "Godot Game avatar method architecture/order drift")
require("var player_anim_def: Variant = null" in bootstrap and "var current_player_portrait_slug: Variant = null" in bootstrap,
        "Godot Game avatar state fields do not preserve source nullable ownership")
require('RuntimeAnimationSetResolverScript := preload("res://scripts/utils/animation_set_resolver.gd")' in bootstrap and
        'RuntimePlaceholderFactoryScript := preload("res://scripts/rendering/placeholder_factory.gd")' in bootstrap,
        "Godot Game avatar methods bypass translated source modules")
require("player.sprite.load_from_paths" not in bootstrap and "RuntimeNpc.portrait_slug_from_anim_file" not in bootstrap,
        "Godot Game avatar loading remains flattened into target-only SpriteEntity/Npc helpers")
require('var player_slug: String = provided.strip_edges() if provided is String else ""' in gd_graph_dialogue_manager,
        "Godot GraphDialogueManager turns a nullable player portrait slug into a literal string")
require('"applyPlayerAvatar": Callable(self, "apply_player_avatar_from_action")' in game_start and
        '"resetPlayerAvatar": Callable(self, "reset_player_avatar_from_action")' in game_start,
        "Godot ActionRegistry avatar dependencies bypass source Game method boundaries")
require(ordered_tokens(game_start, [
    "load_flag_registry()", "wire_text_resolve()", 'await setup_player({"deferAvatar": is_dev_mode})',
    "scene_manager.load_initial_scene(initial_scene)",
]), "Godot Game.setupPlayer startup phase drift")
require(game_start.count("interaction_system.set_player_position_getter(") == 0 and game_start.count("zone_system.set_player_position_getter(") == 0,
        "Godot Game.start retains player position getter ownership outside setupPlayer")

require(ordered_tokens(ts_scenario_state_manager, [
    "private byScenario", "private lineLifecycleByScenario", "private manualLifecycleScenarioIds",
    "private flagStore", "private catalog", "private eventBus", "configureRuntime(",
    "getCatalogScenarioIds(", "hasManualLineLifecycle(", "init(",
    "assertScenarioLineEntryForAction(", "update(", "destroy(",
    "resetScenarioProgressForDebug(", "debugSetScenarioLineLifecycle(",
    "debugSetScenarioPhase(", "isFirstWriteToScenario(",
    "assertScenarioLineEntryMetOrThrow(", "usesManualLineLifecycle(",
    "getLineLifecycleState(", "notifyScenarioLifecycleError(", "throwLifecycle(",
    "activateScenarioLine(", "completeScenarioLine(", "evalCatalogRequiresMet(",
    "setScenarioPhase(", "coerceExposeValue(", "tryApplyExposes(",
    "getScenarioPhase(", "phaseStatusEquals(", "checkPrerequisites(",
    "serialize(", "deserialize(",
]), "TypeScript ScenarioStateManager field/method architecture drift")
require(ordered_tokens(gd_scenario_state_manager, [
    "var _by_scenario", "var _line_lifecycle_by_scenario", "var _manual_lifecycle_scenario_ids",
    "var _flag_store", "var _catalog", "var _event_bus", "func configure_runtime(",
    "func get_catalog_scenario_ids(", "func has_manual_line_lifecycle(", "func init(",
    "func assert_scenario_line_entry_for_action(", "func update(", "func destroy(",
    "func reset_scenario_progress_for_debug(", "func debug_set_scenario_line_lifecycle(",
    "func debug_set_scenario_phase(", "func _is_first_write_to_scenario(",
    "func _assert_scenario_line_entry_met_or_throw(", "func _uses_manual_line_lifecycle(",
    "func get_line_lifecycle_state(", "func _notify_scenario_lifecycle_error(", "func _throw_lifecycle(",
    "func activate_scenario_line(", "func complete_scenario_line(", "func _eval_catalog_requires_met(",
    "func set_scenario_phase(", "func _coerce_expose_value(", "func _try_apply_exposes(",
    "func get_scenario_phase(", "func phase_status_equals(", "func check_prerequisites(",
    "func serialize(", "func deserialize(",
]), "Godot ScenarioStateManager field/method architecture/order drift")
for forbidden_scenario_member in ["func _init(", "func load_catalog(", "_asset_manager", "_catalog_by_id", "func catalog_count(", "func last_error("]:
    require(forbidden_scenario_member not in gd_scenario_state_manager, f"Godot ScenarioStateManager invented non-source ownership: {forbidden_scenario_member}")
require("scenario_state_manager = RuntimeScenarioStateManager.new()" in bootstrap, "Godot Game does not construct ScenarioStateManager without dependencies like TypeScript")
require(ordered_tokens(bootstrap, [
    'asset_manager.load_json("/assets/data/scenarios.json")',
    "scenario_state_manager.configure_runtime(flag_store, scenario_catalog",
]), "Godot Game does not own scenarios.json load -> configureRuntime wiring")

require(ordered_tokens(ts_interaction, [
    "private eventBus", "private deps", "private boundCallbacks", "private hotspotChain",
    "constructor(", "init(", "listen(", "handleHotspot(", "handleNpc(",
    "debugTriggerHotspotById(", "debugInteractNpcById(", "handleInspect(",
    "handleInspectGraph(", "handlePickup(", "handleEncounterTrigger(",
    "handleTransition(", "destroy(",
]), "TypeScript InteractionCoordinator field/method architecture drift")
require(ordered_tokens(interaction, [
    "var _event_bus", "var _deps", "var _bound_callbacks", "var _hotspot_chain",
    "func _init(", "func init(", "func _listen(", "func _handle_hotspot(",
    "func _handle_npc(", "func debug_trigger_hotspot_by_id(",
    "func debug_interact_npc_by_id(", "func _handle_inspect(",
    "func _handle_inspect_graph(", "func _handle_pickup(",
    "func _handle_encounter_trigger(", "func _handle_transition(", "func destroy(",
]), "Godot InteractionCoordinator field/method architecture/order drift")
ts_interaction_fields = re.findall(r"^  private ([A-Za-z_][A-Za-z0-9_]*)\s*:", ts_interaction, flags=re.MULTILINE)
gd_interaction_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", interaction, flags=re.MULTILINE)
require(ts_interaction_fields == ["eventBus", "deps", "boundCallbacks", "hotspotChain"], f"TypeScript InteractionCoordinator field ownership drift: {ts_interaction_fields}")
require(gd_interaction_fields == ["_event_bus", "_deps", "_bound_callbacks", "_hotspot_chain"], f"Godot InteractionCoordinator field ownership drift: {gd_interaction_fields}")
gd_interaction_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)\(", interaction, flags=re.MULTILINE)
require(gd_interaction_methods == [
    "_init", "init", "_listen", "_handle_hotspot", "_handle_npc",
    "debug_trigger_hotspot_by_id", "debug_interact_npc_by_id", "_handle_inspect",
    "_handle_inspect_graph", "_handle_pickup", "_handle_encounter_trigger",
    "_handle_transition", "destroy",
], f"Godot InteractionCoordinator method surface drift: {gd_interaction_methods}")
for forbidden_interaction_member in [
    "_start_graph", "_start_encounter", "_hotspot_queue", "_queue_running", "_destroyed",
    "_dialogue_npc", "_dialogue_camera_zoom",
    "_pending_graph_inspect", "set_graph_dialogue_starter", "set_encounter_starter",
    "set_test_graph_dialogue_starter", "func _on_", "func _drain_hotspot_queue",
    "func _cleanup_dialogue_npc", "RuntimeInteractionSystem",
]:
    require(forbidden_interaction_member not in interaction, f"Godot InteractionCoordinator invented non-source ownership/API: {forbidden_interaction_member}")
require(not re.search(r"^var (?:state_controller|scene_manager|action_executor|inspect_box|player|camera):", interaction, flags=re.MULTILINE), "Godot InteractionCoordinator flattens source InteractionDeps into owned fields")
require("RuntimeAsyncTail.new()" in interaction and "_hotspot_chain.then(job)" in interaction, "Godot InteractionCoordinator does not translate the source Promise tail through RuntimeAsyncTail")
require('{"event": event, "fn": callback}' in interaction and "binding.fn" in interaction, "Godot InteractionCoordinator listener ownership/lifecycle drift")
require("RuntimeHotspotInteractionScript.inspect_data_has_interactable_payload(data)" in interaction, "Godot InteractionCoordinator bypasses the translated hotspotInteraction utility")
require(ordered_tokens(ts_hotspot_interaction, [
    "inspectDataHasInteractablePayload(", "hotspotOffersPlayerInteraction(",
    "case 'inspect'", "case 'pickup'", "case 'transition'", "case 'encounter'", "case 'npc'",
]), "TypeScript hotspotInteraction module architecture drift")
require(ordered_tokens(gd_hotspot_interaction, [
    "static func inspect_data_has_interactable_payload(",
    "static func hotspot_offers_player_interaction(",
    '"inspect"', '"pickup"', '"transition"', '"encounter"', '"npc"',
]), "Godot hotspotInteraction module architecture/order drift")
gd_hotspot_methods = re.findall(r"^static func ([A-Za-z_][A-Za-z0-9_]*)\(", gd_hotspot_interaction, flags=re.MULTILINE)
require(gd_hotspot_methods == ["inspect_data_has_interactable_payload", "hotspot_offers_player_interaction"], f"Godot hotspotInteraction method surface drift: {gd_hotspot_methods}")

ts_interaction_system_fields = re.findall(r"^  private ([A-Za-z_][A-Za-z0-9_]*)\s*:", ts_interaction_system, flags=re.MULTILINE)
gd_interaction_system_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_interaction_system, flags=re.MULTILINE)
require(ts_interaction_system_fields == [
    "hotspots", "npcs", "nearestTarget", "autoTriggeredInRange", "eventBus", "flagStore", "inputManager",
    "conditionCtxFactory", "playerPosGetter", "hotspotBaseEnabled", "npcBaseVisible", "planePolicy",
], f"TypeScript InteractionSystem field ownership/order drift: {ts_interaction_system_fields}")
require(gd_interaction_system_fields == [
    "hotspots", "npcs", "_nearest_target", "_auto_triggered_in_range", "event_bus", "flag_store", "input_manager",
    "_condition_context_factory", "_player_position_getter", "_hotspot_base_reader", "_npc_base_reader", "_plane_policy",
], f"Godot InteractionSystem field ownership/order drift: {gd_interaction_system_fields}")
gd_interaction_system_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)\(", gd_interaction_system, flags=re.MULTILINE)
require(gd_interaction_system_methods == [
    "_init", "init", "serialize", "deserialize", "set_condition_eval_context_factory",
    "set_entity_base_visibility_readers", "_eval_conditions_list", "_eval_with", "set_player_position_getter",
    "set_plane_interaction_policy", "set_hotspots", "clear_hotspots", "set_npcs", "clear_npcs",
    "_clear_nearest_if_kind", "_apply_hotspot_visibility_and_base", "_apply_npc_visibility_and_base", "update",
    "get_player_visible_entities", "get_nearest_prompt", "debug_list_interactables", "_is_same_target",
    "_hide_current_prompt", "_show_current_prompt", "_trigger_target", "destroy",
], f"Godot InteractionSystem method surface/order drift: {gd_interaction_system_methods}")
for forbidden_interaction_system_member in [
    "_update_enabled_getter", "set_update_enabled_getter", "func set_entities(",
    "static func hotspot_offers_player_interaction(", "Vector2(", ".length()", '"instance"',
]:
    require(forbidden_interaction_system_member not in gd_interaction_system, f"Godot InteractionSystem invented or flattened source architecture: {forbidden_interaction_system_member}")
require("RuntimeHotspotInteractionScript.hotspot_offers_player_interaction" in gd_interaction_system, "Godot InteractionSystem bypasses the translated hotspotInteraction utility")
require(all(token in gd_interaction_system for token in [
    'sqrt(auto_dx * auto_dx + auto_dy * auto_dy)', 'sqrt(dx * dx + dy * dy)',
    '{"kind": "hotspot", "hotspot": hotspot}', '{"kind": "npc", "npc": npc}',
]), "Godot InteractionSystem distance/target-shape translation drift")
gd_interaction_destroy = gd_function(gd_interaction_system, "destroy")
require("_condition_context_factory = Callable()" not in gd_interaction_destroy, "Godot InteractionSystem destroy diverges from the current source lifecycle")
gd_setup_scene_manager = gd_function(bootstrap, "setup_scene_manager")
require(ordered_tokens(gd_setup_scene_manager, [
    "scene_manager.set_interaction_setter", "interaction_system.set_hotspots(hotspots)", "interaction_system.set_npcs(npcs)",
]), "Godot Game.setup_scene_manager compresses the source InteractionSystem setter wiring")
require("interaction_system.set_update_enabled_getter" not in bootstrap, "Godot Game injects a target-only InteractionSystem state gate")

expected_ts_cutscene_fields = [
    "eventBus", "flagStore", "actionExecutor", "cutsceneRenderer", "cutsceneDefs",
    "parallaxScenes", "playing", "waitClickResolve", "dialogueResolve",
    "dialogueAdvanceNotBefore", "waitClickNotBefore", "onClickBound",
    "entityResolver", "sceneSwitcher", "tempActors", "emoteBubbleProvider",
    "emoteTargetResolver", "inputManager", "audioManager", "assetManager",
    "unsubPointer", "unsubKey", "destroyed", "skipping", "stepEpoch", "worldEpoch",
    "snapshot", "playbackCutsceneId", "playbackPathLast", "playbackLabelLast",
    "sceneIdGetter", "playerPositionGetter", "playerPositionSetter", "cameraAccessor",
    "spawnPointResolver", "scriptedSpeakerResolver", "colonSpeakerNarratorBaselineResolved",
    "displayTextResolver", "sceneManagerAPI", "activeSubtitleVoiceStops",
]
expected_gd_cutscene_fields = [
    "event_bus", "flag_store", "action_executor", "cutscene_renderer", "cutscene_defs",
    "parallax_scenes", "playing", "wait_click_resolve", "dialogue_resolve",
    "dialogue_advance_not_before", "wait_click_not_before", "on_click_bound",
    "entity_resolver", "scene_switcher", "temp_actors", "emote_bubble_provider",
    "emote_target_resolver", "input_manager", "audio_manager", "asset_manager",
    "unsub_pointer", "unsub_key", "destroyed", "skipping", "step_epoch", "world_epoch",
    "snapshot", "playback_cutscene_id", "playback_path_last", "playback_label_last",
    "scene_id_getter", "player_position_getter", "player_position_setter", "camera_accessor",
    "spawn_point_resolver", "scripted_speaker_resolver", "colon_speaker_narrator_baseline_resolved",
    "display_text_resolver", "scene_manager_api", "active_subtitle_voice_stops",
]
ts_cutscene_class = section(ts_cutscene_manager, "export class CutsceneManager", "\n}")
ts_cutscene_fields = re.findall(r"^  private (?:readonly )?([A-Za-z_][A-Za-z0-9_]*)(?:!|:|\s*=)", ts_cutscene_class, flags=re.MULTILINE)
gd_cutscene_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", cutscene_manager, flags=re.MULTILINE)
require(ts_cutscene_fields == expected_ts_cutscene_fields, f"TypeScript CutsceneManager field ownership/order drift: {ts_cutscene_fields}")
require(gd_cutscene_fields == expected_gd_cutscene_fields, f"Godot CutsceneManager field ownership/order drift: {gd_cutscene_fields}")

require(ordered_tokens(ts_cutscene_manager, [
    "constructor(", "init(ctx:", "update(_dt:", "setInputManager(", "setAudioManager(",
    "setEntityResolver(", "setEmoteBubbleProvider(", "setEmoteTargetResolver(",
    "setSceneSwitcher(", "setSceneIdGetter(", "setPlayerPositionGetter(",
    "setPlayerPositionSetter(", "setCameraAccessor(", "setSpawnPointResolver(",
    "setScriptedSpeakerResolver(", "setDisplayTextResolver(",
    "setColonSpeakerNarratorBaselineResolved(", "setSceneManager(", "getCutsceneIds(",
    "getCutsceneDef(", "getPlaybackHudSnapshot(", "fadingCameraZoom(",
    "showOverlayImage(", "hideOverlayImage(", "blendOverlayImage(",
    "fadeWorldToBlack(", "fadeWorldFromBlack(", "loadDefs(", "getParallaxScene(",
    "collectImagePathsFromSteps(", "startCutscene(", "skip(",
    "saveAndTransitionReturningCrossScene(", "captureSnapshot(", "restoreSnapshot(",
    "isStepStale(", "canArmWait(", "executeSteps(", "formatPlaybackStepLabel(",
    "emitPlaybackStep(", "executeOneStep(", "executePresent(", "get isPlaying",
    "getTempActors(", "spawnTempActor(", "removeTempActor(", "entitySpawn(",
    "entityRemove(", "entitySetVisible(", "waitForClick(",
    "mergePresentShowDialogueLine(", "showDialogueText(", "resolveShowSubtitleLayout(",
    "parseSubtitleEmoteSpec(", "parseSubtitleVoiceSpec(", "parseSubtitleAutoAdvanceSpec(",
    "showSubtitleText(", "stopActiveSubtitleVoices(", "cleanup(", "serialize(",
    "deserialize(", "destroy(",
]), "TypeScript CutsceneManager method architecture/order drift")
require(ordered_tokens(cutscene_manager, [
    "func _init(", "func init(", "func update(", "func set_input_manager(",
    "func set_audio_manager(", "func set_entity_resolver(", "func set_emote_bubble_provider(",
    "func set_emote_target_resolver(", "func set_scene_switcher(", "func set_scene_id_getter(",
    "func set_player_position_getter(", "func set_player_position_setter(",
    "func set_camera_accessor(", "func set_spawn_point_resolver(",
    "func set_scripted_speaker_resolver(", "func set_display_text_resolver(",
    "func set_colon_speaker_narrator_baseline_resolved(", "func set_scene_manager(",
    "func get_cutscene_ids(", "func get_cutscene_def(", "func get_playback_hud_snapshot(",
    "func fading_camera_zoom(", "func show_overlay_image(", "func hide_overlay_image(",
    "func blend_overlay_image(", "func fade_world_to_black(", "func fade_world_from_black(",
    "func load_defs(", "func _get_parallax_scene(", "func _collect_image_paths_from_steps(",
    "func start_cutscene(", "func skip(", "func _save_and_transition_returning_cross_scene(",
    "func _capture_snapshot(", "func _restore_snapshot(", "func _is_step_stale(",
    "func _can_arm_wait(", "func _execute_steps(", "func _format_playback_step_label(",
    "func _emit_playback_step(", "func _execute_one_step(", "func _execute_present(",
    "func is_playing(", "func get_temp_actors(", "func spawn_temp_actor(",
    "func remove_temp_actor(", "func _entity_spawn(", "func _entity_remove(",
    "func _entity_set_visible(", "func _wait_for_click(",
    "func _merge_present_show_dialogue_line(", "func _show_dialogue_text(",
    "func _resolve_show_subtitle_layout(", "func _parse_subtitle_emote_spec(",
    "func _parse_subtitle_voice_spec(", "func _parse_subtitle_auto_advance_spec(",
    "func _show_subtitle_text(", "func _stop_active_subtitle_voices(", "func _cleanup(",
    "func serialize(", "func deserialize(", "func destroy(",
]), "Godot CutsceneManager method architecture/order drift")
gd_cutscene_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)\(", cutscene_manager, flags=re.MULTILINE)
require(gd_cutscene_methods == [
    "_init", "init", "update", "set_input_manager", "set_audio_manager",
    "set_entity_resolver", "set_emote_bubble_provider", "set_emote_target_resolver",
    "set_scene_switcher", "set_scene_id_getter", "set_player_position_getter",
    "set_player_position_setter", "set_camera_accessor", "set_spawn_point_resolver",
    "set_scripted_speaker_resolver", "set_display_text_resolver",
    "set_colon_speaker_narrator_baseline_resolved", "set_scene_manager",
    "get_cutscene_ids", "get_cutscene_def", "get_playback_hud_snapshot",
    "fading_camera_zoom", "show_overlay_image", "hide_overlay_image",
    "blend_overlay_image", "fade_world_to_black", "fade_world_from_black", "load_defs",
    "_get_parallax_scene", "_collect_image_paths_from_steps", "start_cutscene", "skip",
    "_save_and_transition_returning_cross_scene", "_capture_snapshot", "_restore_snapshot",
    "_is_step_stale", "_can_arm_wait", "_execute_steps", "_format_playback_step_label",
    "_emit_playback_step", "_execute_one_step", "_execute_parallel", "_run_parallel_track",
    "_execute_present", "is_playing", "get_temp_actors", "spawn_temp_actor",
    "remove_temp_actor", "_entity_spawn", "_entity_remove", "_entity_set_visible",
    "_wait_for_click", "_merge_present_show_dialogue_line", "_show_dialogue_text",
    "_resolve_show_subtitle_layout", "_parse_subtitle_emote_spec",
    "_parse_subtitle_voice_spec", "_parse_subtitle_auto_advance_spec",
    "_show_subtitle_text", "_run_subtitle_auto_timer", "_finish_subtitle_wait",
    "_stop_active_subtitle_voices", "_cleanup", "serialize",
    "deserialize", "destroy", "_on_click_bound", "_on_key_down", "_unsubscribe_inputs",
    "_resolve_display_text",
], f"Godot CutsceneManager method surface drift: {gd_cutscene_methods}")
for forbidden_cutscene_member in [
    "set_runtime_support", "set_resolve_display", "set_narrator_baseline", "set_time_scale",
    "has_cutscene", "func get_temp_actor(", "debug_advance", "renderer_entity_layer",
    "_advance_serial", "_parallel_counts", "var player:", "var camera:", "var scene_manager:",
    "scene_manager.get_hotspot_by_id",
]:
    require(forbidden_cutscene_member not in cutscene_manager, f"Godot CutsceneManager invented or flattened non-source ownership/API: {forbidden_cutscene_member}")
require("cutscene_manager = RuntimeCutsceneManager.new(event_bus, flag_store, action_executor, cutscene_renderer)" in bootstrap, "Godot Game CutsceneManager constructor dependency shape/order drift")
require(ordered_tokens(bootstrap, [
    "cutscene_manager.set_input_manager(input_manager)",
    "cutscene_manager.set_audio_manager(audio_manager)",
    "cutscene_manager.set_entity_resolver(resolve_actor_fn)",
    "cutscene_manager.set_emote_bubble_provider(emote_bubble_manager)",
    'cutscene_manager.set_emote_target_resolver(Callable(self, "_resolve_emote_target"))',
    'cutscene_manager.set_scene_switcher(Callable(self, "_switch_scene_for_cutscene"))',
    "cutscene_manager.set_scene_id_getter(", "cutscene_manager.set_player_position_getter(",
    "cutscene_manager.set_player_position_setter(", "cutscene_manager.set_camera_accessor(camera)",
    "cutscene_manager.set_scene_manager(scene_manager)",
    'cutscene_manager.set_spawn_point_resolver(Callable(self, "_resolve_cutscene_spawn_point"))',
    "cutscene_manager.set_scripted_speaker_resolver(",
]), "Godot Game CutsceneManager setter dependency topology/order drift")
require('resolve_actor_fn = Callable(self, "_resolve_action_actor")' in bootstrap and '"resolveActor": resolve_actor_fn' in bootstrap, "Godot Game does not retain one shared source-shaped resolveActorFn field")
require("for npc: RuntimeNpc in cutscene_manager.get_temp_actors().values(): npc.cutscene_update(dt)" in bootstrap, "Godot Game does not own temporary cutscene actor updates")
require("func update(_dt: float) -> void:\n\treturn" in cutscene_manager, "Godot CutsceneManager.update owns ticking absent from the source")
require("RuntimeAsyncLatch.new()" in cutscene_manager, "Godot CutsceneManager does not translate source wait resolvers through the Promise latch adapter")
require(ordered_tokens(ts_audio_manager, [
    "export class AudioManager implements IGameSystem, IAudioSettingsProvider", "private eventBus",
    "private config", "private loaded", "private currentBgm", "private currentBgmId",
    "private requestedBgmId", "private bgmRequestSeq", "private currentBgmBaseVolume",
    "private ambientLayers", "private requestedAmbientIds", "private ambientBaseVolume",
    "private ambientRequestSeq", "private sfxCache", "private cutsceneSfxActive",
    "private cutsceneSfxSounds", "private bgmVolume", "private sfxVolume", "private ambientVolume",
    "private pendingTimers", "private assetManager", "private audioUnblocked", "private audioUnlocking",
    "private pendingPlayback", "private gestureListenersInstalled", "private sfxEventListeners",
    "private lastMapTravelSfxAt", "constructor(", "init(", "update(", "async loadConfig(",
    "playBgm(", "stopBgm(", "private bumpAmbientSeq(", "addAmbient(", "removeAmbient(",
    "clearAmbient(", "playSfx(", "beginCutsceneSfxCapture(", "endCutsceneSfxCapture(",
    "getCurrentBgmId(", "getActiveAmbientIds(", "getRequestedBgmId(", "getRequestedAmbientIds(",
    "getDebugOutputState(", "restoreAudioBaseline(", "playTransientSfx(", "setVolume(",
    "getVolume(", "applySceneAudio(", "serialize(", "deserialize(", "private clamp01(",
    "private scheduleCleanup(", "getSceneAudioRefs(", "private runWhenAudioAllowed(",
    "private playAudioUnlockCue(", "private flushPendingPlayback(", "private readonly _onFirstGesture",
    "private installAudioGestureGate(", "private pageHasUserActivation(",
    "private removeAudioGestureListeners(", "private playSystemSfx(", "private onSfx(",
    "private installSystemSfxListeners(", "destroy(",
]), "TypeScript AudioManager field/method architecture drift")
audio_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_audio_manager, flags=re.MULTILINE)
audio_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_audio_manager, flags=re.MULTILINE)
require(audio_fields == [
    "event_bus", "config", "loaded", "current_bgm", "current_bgm_id", "requested_bgm_id",
    "bgm_request_seq", "current_bgm_base_volume", "ambient_layers", "requested_ambient_ids",
    "ambient_base_volume", "ambient_request_seq", "sfx_cache", "cutscene_sfx_active",
    "cutscene_sfx_sounds", "bgm_volume", "sfx_volume", "ambient_volume", "pending_timers",
    "asset_manager", "audio_unblocked", "audio_unlocking", "pending_playback",
    "gesture_listeners_installed", "sfx_event_listeners", "last_map_travel_sfx_at",
    # Godot player/fade adapters follow every direct field.
    "active_sfx", "_fading_players", "_volume_fades",
], f"Godot AudioManager direct/engine-adapter field architecture/order drift: {audio_fields}")
require(audio_methods == [
    "_init", "init", "update", "load_config", "play_bgm", "stop_bgm", "_bump_ambient_seq",
    "add_ambient", "remove_ambient", "clear_ambient", "play_sfx", "begin_cutscene_sfx_capture",
    "end_cutscene_sfx_capture", "get_current_bgm_id", "get_active_ambient_ids",
    "get_requested_bgm_id", "get_requested_ambient_ids", "get_debug_output_state",
    "restore_audio_baseline", "play_transient_sfx", "set_volume", "get_volume",
    "apply_scene_audio", "serialize", "deserialize", "_clamp01", "_schedule_cleanup",
    "get_scene_audio_refs", "_run_when_audio_allowed", "_play_audio_unlock_cue",
    "_flush_pending_playback", "_on_first_gesture", "_install_audio_gesture_gate",
    "_page_has_user_activation", "_remove_audio_gesture_listeners", "_play_system_sfx",
    "_on_sfx", "_install_system_sfx_listeners", "destroy",
    # Godot engine/test adapters follow every direct method.
    "has_audio", "debug_active_sfx_count", "stop_all_playback", "_resolve_asset_path",
    "_new_audio_player", "_create_sfx_player", "_release_sfx", "_on_sfx_finished",
    "_release_sfx_by_id", "_linear_db", "_player_linear_volume", "_stop_and_free",
    "_cancel_volume_fade", "_start_linear_fade", "_process", "_advance_volume_fades",
    "_take_fading_player_for_stream",
], f"Godot AudioManager direct/engine-adapter method architecture/order drift: {audio_methods}")
for forbidden_audio_api in [
    "ambient_base_volumes", "_capturing_cutscene_sfx", "_captured_cutscene_sfx",
    "var _event_listeners", "var _last_map_travel_sfx_at", "func _load_entry(", "func _entry_volume(",
    "func _fade_and_free(", "func _tween_linear_volume(", "func _listen(", "func _system_sfx(",
    "func stop_transient_sfx(", "clear_ambient()\n\tclear_ambient()",
]:
    require(forbidden_audio_api not in gd_audio_manager,
            f"Godot AudioManager retains flattened/non-source state or API: {forbidden_audio_api}")
require(ordered_tokens(gd_function(gd_audio_manager, "init"), [
    "asset_manager = ctx.assetManager", "_install_audio_gesture_gate()", "_install_system_sfx_listeners()",
]), "Godot AudioManager init asset/gate/system-listener order drift")
require(gd_function(gd_audio_manager, "update").strip().endswith("return"),
        "Godot AudioManager invents source-absent update ownership")
require(ordered_tokens(gd_function(gd_audio_manager, "load_config"), [
    "asset_manager.load_json(CONFIG_URL)", "await RuntimeMicrotaskQueueScript.yield_turn()",
    "if not raw is Dictionary:", 'push_warning("AudioManager: audio_config.json not found, running silent")',
    "loaded = true", "var resolve_src := func", '"src": _resolve_asset_path(',
    'value.get("volume") is int', "entry.volume = float(value.volume)",
    'raw.get("systemSfx", {})', "value is String", "value.strip_edges().is_empty()",
    '"bgm": resolve_src.call', '"ambient": resolve_src.call', '"sfx": resolve_src.call',
    '"systemSfx": system_sfx', "loaded = true",
]), "Godot AudioManager loadConfig resolve/filter/silent-fallback contract drift")
audio_play_bgm = gd_function(gd_audio_manager, "play_bgm")
require(ordered_tokens(audio_play_bgm, [
    "requested_bgm_id = id", "bgm_request_seq += 1", "var my_request := bgm_request_seq",
    "_run_when_audio_allowed(", "my_request != bgm_request_seq",
    "current_bgm_id == id and current_bgm != null", "config.bgm.get(id)",
    'push_warning(\'AudioManager: unknown bgm', 'asset_manager.get_audio(str(entry.src), {"loop": true})',
    'asset_manager.load_audio(str(entry.src), {"loop": true})',
    "await RuntimeMicrotaskQueueScript.yield_turn()", "my_request != bgm_request_seq",
    "current_bgm_id == id", "var old := current_bgm", "old.stream == stream",
    "_take_fading_player_for_stream(stream)", "_new_audio_player(", "old != null and old != player",
    "_start_linear_fade(old", "_schedule_cleanup(", "if current_bgm != old:",
    "_stop_and_free(old)", "player.stop()", "player.volume_db = _linear_db(0.0)",
    "player.play()", 'entry.get("volume", 1.0)', "_clamp01(base_volume * bgm_volume)",
    "current_bgm = player", "current_bgm_id = id", "current_bgm_base_volume = base_volume",
]), "Godot AudioManager BGM intent/epoch/load/reuse/fade/atomic-commit drift")
require(ordered_tokens(gd_function(gd_audio_manager, "stop_bgm"), [
    "requested_bgm_id = null", "bgm_request_seq += 1", "_run_when_audio_allowed(",
    "if current_bgm == null:", "var bgm := current_bgm", "_start_linear_fade(",
    "_schedule_cleanup(", "if current_bgm != bgm:", "_stop_and_free(bgm)",
    "current_bgm = null", "current_bgm_id = null",
]) and "current_bgm_base_volume = 1.0" not in gd_function(gd_audio_manager, "stop_bgm"),
        "Godot AudioManager stopBgm intent/invalidation/guarded-cleanup drift")
require(ordered_tokens(gd_function(gd_audio_manager, "_bump_ambient_seq"), [
    'int(ambient_request_seq.get(id, 0)) + 1', "ambient_request_seq[id] = next", "return next",
]), "Godot AudioManager ambient monotonic generation drift")
require(ordered_tokens(gd_function(gd_audio_manager, "add_ambient"), [
    "requested_ambient_ids[id] = true", "_bump_ambient_seq(id)", "_run_when_audio_allowed(",
    "my_request != int(ambient_request_seq.get(id, 0))", "ambient_layers.has(id)",
    "config.ambient.get(id)", 'push_warning(\'AudioManager: unknown ambient',
    "float(volume) if volume != null", 'entry.get("volume", 1.0)',
    'asset_manager.get_audio(str(entry.src), {"loop": true})',
    'asset_manager.load_audio(str(entry.src), {"loop": true})',
    "await RuntimeMicrotaskQueueScript.yield_turn()", "my_request != int(ambient_request_seq.get(id, 0))",
    "ambient_layers.has(id)", "_take_fading_player_for_stream(stream)", "player.stop()",
    "_clamp01(base_volume * ambient_volume)", "player.play()", "ambient_layers[id] = player",
    "ambient_base_volume[id] = base_volume",
]), "Godot AudioManager ambient add intent/epoch/load/reuse/base-volume drift")
require(ordered_tokens(gd_function(gd_audio_manager, "remove_ambient"), [
    "requested_ambient_ids.erase(id)", "_bump_ambient_seq(id)", "_run_when_audio_allowed(",
    "ambient_layers.get(id)", "_start_linear_fade(", "_schedule_cleanup(",
    "ambient_layers.get(id) != player", "_stop_and_free(player)", "ambient_layers.erase(id)",
    "ambient_base_volume.erase(id)",
]), "Godot AudioManager ambient remove invalidation/guarded-cleanup drift")
require(ordered_tokens(gd_function(gd_audio_manager, "clear_ambient"), [
    "requested_ambient_ids.clear()", "ambient_request_seq.keys()", "_bump_ambient_seq(key)",
    "_run_when_audio_allowed(", "for id: String in ambient_layers:", "_start_linear_fade(",
    "_schedule_cleanup(", "ambient_layers.get(id) != player", "_stop_and_free(player)",
    "ambient_layers.clear()", "ambient_base_volume.clear()",
]), "Godot AudioManager ambient clear all-pending-generation/fade drift")
audio_play_sfx = gd_function(gd_audio_manager, "play_sfx")
require(ordered_tokens(audio_play_sfx, [
    "var capture_for_cutscene := cutscene_sfx_active", "_run_when_audio_allowed(",
    "config.sfx.get(id)", "sfx_cache.get(id)", 'asset_manager.get_audio(str(entry.src), {"loop": false})',
    'asset_manager.load_audio(str(entry.src), {"loop": false})',
    "await RuntimeMicrotaskQueueScript.yield_turn()", "sfx_cache[id] = stream",
    "is_finite(float(volume))", 'entry.get("volume", 1.0)', "_clamp01(base_volume * sfx_volume)",
    "if capture_for_cutscene and cutscene_sfx_active:", "cutscene_sfx_sounds.push_back(player)",
]), "Godot AudioManager playSfx cache/volume/synchronous-capture-intent drift")
require(ordered_tokens(gd_function(gd_audio_manager, "begin_cutscene_sfx_capture"), [
    "cutscene_sfx_active = true", "cutscene_sfx_sounds = []",
]) and ordered_tokens(gd_function(gd_audio_manager, "end_cutscene_sfx_capture"), [
    "cutscene_sfx_active = false", "if stop_playing:", "for player: AudioStreamPlayer in cutscene_sfx_sounds:",
    "_release_sfx(player)", "cutscene_sfx_sounds = []",
]), "Godot AudioManager cutscene SFX interrupt-vs-natural capture contract drift")
require('"activeSfxCount": sfx_cache.size()' in gd_function(gd_audio_manager, "get_debug_output_state"),
        "Godot AudioManager debug state confuses source cache size with live engine instances")
require(ordered_tokens(gd_function(gd_audio_manager, "restore_audio_baseline"), [
    "bgm_id is String", "play_bgm(bgm_id)", "else:", "stop_bgm()",
    "for id: String in ambient_ids:", "add_ambient(id)",
]) and "clear_ambient" not in gd_function(gd_audio_manager, "restore_audio_baseline"),
        "Godot AudioManager restore baseline adds source layers incorrectly")
audio_transient = gd_function(gd_audio_manager, "play_transient_sfx")
require(ordered_tokens(ts_audio_manager, [
    "playTransientSfx(", "let stopped = false", "const handle: AudioPlaybackHandle", "stop: () =>",
    "if (stopped) return", "stopped = true", "endListener = () =>", "options.onEnd?.()", "return handle",
]), "TypeScript transient AudioPlaybackHandle lifecycle drift")
require(re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)\(", gd_audio_playback_handle, flags=re.MULTILINE) == [
    "_init", "stop", "_complete_naturally", "is_stopped",
], "Godot AudioPlaybackHandle method surface/order drift")
require(ordered_tokens(audio_transient, [
    "config.sfx.get(id)", "if not entry is Dictionary:", "return null", '"stopped": false',
    "RuntimeAudioPlaybackHandle.new(", "if state.stopped == true:", "state.stopped = true",
    "_release_sfx(player)", "_run_when_audio_allowed(", "if state.stopped == true:",
    'asset_manager.get_audio(str(entry.src), {"loop": false})',
    'asset_manager.load_audio(str(entry.src), {"loop": false})',
    "await RuntimeMicrotaskQueueScript.yield_turn()", "if state.stopped == true:",
    'options.get("volume")', "is_finite(float(raw_volume))", 'entry.get("volume", 1.0)',
    "_create_sfx_player(", "state.player = player", 'options.get("onEnd")',
    "player.finished.connect(", "state.stopped = true", "state.player = null",
    "handle._complete_naturally()", "on_end.call()", "return handle",
]) and "cutscene_sfx_sounds" not in audio_transient,
        "Godot AudioManager transient immediate-handle/cancel/load/natural-end/excluded-capture drift")
require(ordered_tokens(gd_function(gd_audio_manager, "set_volume"), [
    "maxf(0.0, minf(1.0, volume))", '"bgm":', "bgm_volume = next",
    "current_bgm_base_volume * next", '"sfx":', "sfx_volume = next", '"ambient":',
    "ambient_volume = next", "ambient_base_volume.get(id, 1.0)",
]) and ordered_tokens(gd_function(gd_audio_manager, "deserialize"), [
    'data.has("bgmVolume")', "bgm_volume = float(data.bgmVolume)", 'data.has("sfxVolume")',
    "sfx_volume = float(data.sfxVolume)", 'data.has("ambientVolume")',
    "ambient_volume = float(data.ambientVolume)",
]) and "set_volume(" not in gd_function(gd_audio_manager, "deserialize"),
        "Godot AudioManager volume/base-multiplier or deserialize-no-side-effect contract drift")
require(ordered_tokens(gd_function(gd_audio_manager, "_schedule_cleanup"), [
    "Timer.new()", "timer.one_shot = true", "milliseconds / 1000.0", "add_child(timer)",
    "pending_timers[timer] = true", "timer.timeout.connect(", "pending_timers.erase(timer)",
    "callback.call()", "timer.queue_free()", "timer.start()",
]), "Godot AudioManager cleanup timer ownership drift")
require(ordered_tokens(gd_function(gd_audio_manager, "_run_when_audio_allowed"), [
    "if audio_unblocked:", "callback.call()", "return", "pending_playback.push_back(callback)",
]), "Godot AudioManager audio-gate queue contract drift")
require(ordered_tokens(gd_function(gd_audio_manager, "_flush_pending_playback"), [
    "audio_unblocked = true", "audio_unlocking = false", "_play_audio_unlock_cue()",
    "pending_playback.duplicate()", "pending_playback.clear()", "callback.call()",
]), "Godot AudioManager unlock flush order drift")
require(ordered_tokens(gd_function(gd_audio_manager, "_install_audio_gesture_gate"), [
    "if gesture_listeners_installed:", "_page_has_user_activation()", "audio_unblocked = true",
    "audio_unlocking = false", "return", "gesture_listeners_installed = true",
]) and "return true" in gd_function(gd_audio_manager, "_page_has_user_activation"),
        "Godot AudioManager native sticky-activation engine adapter drift")
ts_audio_sfx_install = section(ts_audio_manager, "private installSystemSfxListeners()", "\n  destroy(): void")
gd_audio_sfx_install = gd_function(gd_audio_manager, "_install_system_sfx_listeners")
require(re.findall(r"this\.onSfx\('([^']+)'", ts_audio_sfx_install) ==
        re.findall(r'_on_sfx\("([^"]+)"', gd_audio_sfx_install),
        "Godot AudioManager system-SFX event registration list/order drift")
require(ordered_tokens(gd_audio_sfx_install, [
    '"quest:accepted"', 'payload.get("restored") == true', '"questAccepted"',
    '"dialogue:end"', 'payload.get("willContinue") == true', 'payload.get("nestedInGraph") == true',
    '"notification:show"', 'type == "warning"', 'type in ["quest", "rule", "archive"]',
    '"scene:transition"', "Time.get_ticks_msec() - last_map_travel_sfx_at < 500",
    '"map:travel"', "last_map_travel_sfx_at = Time.get_ticks_msec()",
    '"currency:changed"', "amount > 0.0", "amount < 0.0", '"rule:layer"',
    'payload.get("source") == "fragment"', '"document:revealed"',
]), "Godot AudioManager system-SFX filter/debounce contract drift")
audio_destroy = gd_function(gd_audio_manager, "destroy")
require(ordered_tokens(audio_destroy, [
    "bgm_request_seq += 1", "ambient_request_seq.keys()", "_bump_ambient_seq(key)",
    "for entry: Dictionary in sfx_event_listeners:", "event_bus.off(", "sfx_event_listeners = []",
    "_remove_audio_gesture_listeners()", "audio_unlocking = false", "pending_playback = []",
    "if current_bgm != null:", "current_bgm = null", "current_bgm_id = null", "_stop_and_free(bgm)",
    "pending_timers.keys()", "timer.stop()", "timer.free()", "pending_timers.clear()",
    "ambient_layers.values()", "_stop_and_free(player)", "ambient_layers.clear()",
    "ambient_base_volume.clear()", "requested_bgm_id = null", "requested_ambient_ids.clear()",
    "current_bgm_base_volume = 1.0", "active_sfx.duplicate()", "_release_sfx(player)",
    "sfx_cache.clear()", "cutscene_sfx_active = false", "cutscene_sfx_sounds = []",
]), "Godot AudioManager destroy generation/listener/gate/player/cache lifecycle drift")
require("player.queue_free()" in gd_function(gd_audio_manager, "_stop_and_free") and
        "player.free()" not in gd_function(gd_audio_manager, "_stop_and_free"),
        "Godot audio engine adapter synchronously frees a signal-locked AudioStreamPlayer")
require("await audio_manager.load_config()" in bootstrap and "if not audio_manager.load_config()" not in bootstrap,
        "Godot Game still consumes source void loadConfig as a target-only boolean API")
require(ordered_tokens(ts_emote_bubble_manager, [
    "interface ActiveBubble", "bubble: Container", "parent: Container", "remainingMs: number",
    "noAutoExpire?: boolean", "owner?: string", "follow?: {", "anchor: IEmoteBubbleAnchor",
    "displayObj: Container", "bw: number", "bh: number", "ox: number", "oy: number",
    "const QUAD_ABOVE_GAP = 8", "export class EmoteBubbleManager implements IGameSystem",
    "private activeBubbles", "private pendingTimers", "private entityAttachLayer", "private debugPanelLog",
    "setEntityAttachLayer(", "setDebugPanelLog(", "private dbg(", "init(", "serialize(",
    "deserialize(", "private buildAndMountBubble(", "show(", "showSticky(", "showAndWait(",
    "update(", "private removeBubble(", "cleanupByOwner(", "cleanup(", "destroy(",
]), "TypeScript EmoteBubbleManager state/method architecture drift")
emote_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_emote_bubble_manager, flags=re.MULTILINE)
emote_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_emote_bubble_manager, flags=re.MULTILINE)
require(emote_fields == [
    "active_bubbles", "pending_timers", "entity_attach_layer", "debug_panel_log", "_time_scale",
], f"Godot EmoteBubbleManager direct/test-clock field architecture/order drift: {emote_fields}")
require(emote_methods == [
    "set_entity_attach_layer", "set_debug_panel_log", "_dbg", "init", "serialize", "deserialize",
    "_build_and_mount_bubble", "show", "show_sticky", "show_and_wait", "update", "_remove_bubble",
    "cleanup_by_owner", "cleanup", "destroy", "set_time_scale",
], f"Godot EmoteBubbleManager direct/test-clock method architecture/order drift: {emote_methods}")
for forbidden_emote_api in [
    "signal bubble_progress", "var _next_id", '"id":', '"sticky":', '"offsetX":', '"offsetY":',
    "func dismiss(", "func _build_bubble(", "func _position_entry(", "func _find_entry(",
    "func _expire_by_id(", "func _remove_by_id(", "func _emit_bubble_progress(",
    "maxf(0.0, duration_ms)", "return -1", "return _next_id",
]:
    require(forbidden_emote_api not in gd_emote_bubble_manager,
            f"Godot EmoteBubbleManager retains flattened/non-source state or API: {forbidden_emote_api}")
require('const QUAD_ABOVE_GAP := 8.0' in gd_emote_bubble_manager,
        "Godot EmoteBubbleManager quad-above gap constant drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "set_debug_panel_log"), [
    "callback is Callable", "callback.is_valid()", "else null",
]) and ordered_tokens(gd_function(gd_emote_bubble_manager, "_dbg"), [
    "debug_panel_log is Callable", "debug_panel_log.is_valid()",
    'debug_panel_log.call("[EmoteBubble] %s" % message)',
]), "Godot EmoteBubbleManager debug-panel injection/prefix contract drift")
require(gd_function(gd_emote_bubble_manager, "init").strip().endswith("return") and
        "return {}" in gd_function(gd_emote_bubble_manager, "serialize") and
        "cleanup()" in gd_function(gd_emote_bubble_manager, "deserialize"),
        "Godot EmoteBubbleManager IGameSystem neutral/load-reset contract drift")
emote_mount = gd_function(gd_emote_bubble_manager, "_build_and_mount_bubble")
require(ordered_tokens(emote_mount, [
    "anchor.get_display_object()", '"mount 开始 anchor=', "Node2D.new()", 'bubble.name = "EmoteBubble"',
    "Label.new()", "text.text = emote", 'font_size\", 20', 'Color("222222")',
    "padding_x := 8.0", "padding_y := 4.0", "bubble_width", "bubble_height",
    "Panel.new()", "Color(1.0, 1.0, 1.0, 0.95)", 'Color("888888")',
    "set_border_width_all(1)", "set_corner_radius_all(6)", "bubble.add_child(background)",
    "text.position = Vector2(padding_x, padding_y)", "bubble.add_child(text)",
    'options.get("anchorOffsetX", 0.0)', 'options.get("anchorOffsetY", 0.0)',
    "attach_parent: Node2D = display_obj", "-bubble_width / 2.0 + offset_x",
    "anchor.get_emote_bubble_anchor_local_y()", "var follow: Variant = null",
    "entity_attach_layer != null and anchor is RuntimeHotspot", "attach_parent = entity_attach_layer",
    'bubble.set_meta("entitySortBand", "front")', "anchor.get_emote_world_quad()",
    "float(quad.left) + float(quad.width) / 2.0 - bubble_width / 2.0 + offset_x",
    "float(quad.top) - QUAD_ABOVE_GAP - bubble_height + offset_y",
    "entity_attach_layer != null and display_obj.get_parent() == entity_attach_layer",
    "display_obj.position.x - bubble_width / 2.0 + offset_x",
    "display_obj.position.y + float(anchor.get_emote_bubble_anchor_local_y()) + offset_y - bubble_height",
    '"anchor": anchor', '"displayObj": display_obj', '"bw": bubble_width', '"bh": bubble_height',
    '"ox": offset_x', '"oy": offset_y',
    "anchor is RuntimeHotspot and entity_attach_layer == null", "bubble.position = Vector2(bubble_x, bubble_y)",
    "attach_parent.add_child(bubble)", '"bubble": bubble', '"parent": attach_parent',
    '"bw": bubble_width', '"bh": bubble_height', '"follow": follow',
]), "Godot EmoteBubbleManager build/mount/local-vs-hotspot-vs-follow translation drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "show"), [
    "_build_and_mount_bubble(anchor, emote, options)", '"show 定时消失 durMs=',
    "active_bubbles.push_back({", '"bubble": mounted.bubble', '"parent": mounted.parent',
    '"remainingMs": duration_ms * _time_scale', '"noAutoExpire": false', '"owner": owner',
    '"follow": mounted.follow',
]), "Godot EmoteBubbleManager show entry/state contract drift")
emote_sticky = gd_function(gd_emote_bubble_manager, "show_sticky")
require(ordered_tokens(emote_sticky, [
    "_build_and_mount_bubble(anchor, emote, options)", '"remainingMs": 0.0',
    '"noAutoExpire": true', '"owner": owner', '"follow": mounted.follow',
    "active_bubbles.push_back(entry)", "return func() -> void:", "var index := -1",
    "is_same(active_bubbles[current_index], entry)", "if index < 0:", "return",
    "_remove_bubble(entry)", "active_bubbles.remove_at(index)",
]), "Godot EmoteBubbleManager sticky Callable/identity/idempotence contract drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "show_and_wait"), [
    "show(anchor, emote, duration_ms, options, owner)", "Timer.new()", "timer.one_shot = true",
    "duration_ms * _time_scale / 1000.0", "add_child(timer)", "pending_timers[timer] = true",
    "timer.start()", "await timer.timeout", "pending_timers.erase(timer)", "timer.queue_free()",
]), "Godot EmoteBubbleManager showAndWait independent timer ownership drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "update"), [
    "range(active_bubbles.size() - 1, -1, -1)", 'entry.get("follow")',
    "follow is Dictionary", "follow.anchor", "follow.displayObj", "not is_instance_valid(display_obj)",
    "display_obj.get_parent() == null", "_remove_bubble(entry)", "active_bubbles.remove_at(index)",
    "continue", "display_obj.position.x - float(follow.bw) / 2.0 + float(follow.ox)",
    "display_obj.position.y", "anchor.get_emote_bubble_anchor_local_y()", "float(follow.oy)",
    "float(follow.bh)", 'entry.get("noAutoExpire") == true', "continue",
    "float(entry.remainingMs) - dt * 1000.0", "float(entry.remainingMs) <= 0.0",
    "_remove_bubble(entry)", "active_bubbles.remove_at(index)",
]), "Godot EmoteBubbleManager reverse follow/raw-dt/expiry update drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "_remove_bubble"), [
    "entry.bubble", "is_instance_valid(bubble)", "bubble.get_parent() != null",
    "bubble.get_parent().remove_child(bubble)", "bubble.free()",
]), "Godot EmoteBubbleManager bubble ownership/destruction drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "cleanup_by_owner"), [
    "range(active_bubbles.size() - 1, -1, -1)", 'entry.get("owner") != owner',
    "continue", "_remove_bubble(entry)", "active_bubbles.remove_at(index)",
]), "Godot EmoteBubbleManager owner-selective cleanup drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "cleanup"), [
    "pending_timers.keys()", "timer.stop()", "timer.free()", "pending_timers.clear()",
    "for entry: Dictionary in active_bubbles:", "_remove_bubble(entry)", "active_bubbles.clear()",
]), "Godot EmoteBubbleManager timer/bubble cleanup symmetry drift")
require(ordered_tokens(gd_function(gd_emote_bubble_manager, "destroy"), [
    "cleanup()", "entity_attach_layer = null", "debug_panel_log = null",
]), "Godot EmoteBubbleManager injected-reference destroy symmetry drift")
require(ordered_tokens(bootstrap, [
    "debug_panel_ui = RuntimeDebugPanelUI.new(", "emote_bubble_manager.set_debug_panel_log(",
    "debug_panel_ui.log(message)",
]), "Godot Game omits source EmoteBubbleManager→DebugPanelUI log injection")
require(ordered_tokens(gd_function(cutscene_manager, "_show_subtitle_text"), [
    "var dismiss_subtitle_emote := Callable()", "dismiss_subtitle_emote =",
    "emote_bubble_provider.show_sticky(", "if dismiss_subtitle_emote.is_valid():",
    "dismiss_subtitle_emote.call()",
]) and ".dismiss(" not in gd_function(cutscene_manager, "_show_subtitle_text"),
        "Godot CutsceneManager does not consume source showSticky dismiss Callable directly")
gd_subtitle = gd_function(cutscene_manager, "_show_subtitle_text")
require(all(token in gd_subtitle for token in [
    "voice is RuntimeAudioPlaybackHandle", "handle.stop()", "active_subtitle_voice_stops[voice_stop_key] = stop_voice",
    "stop_voice.call()", "active_subtitle_voice_stops.erase(voice_stop_key)",
]), "Godot CutsceneManager bypasses source AudioPlaybackHandle/active-stop-set ownership")
require("_stop_voice_by_id" not in cutscene_manager and "AudioStreamPlayer" not in gd_subtitle,
        "Godot CutsceneManager retains engine-player ownership absent from the source")
require(ordered_tokens(section(cutscene_manager, "func start_cutscene(", "func skip("), [
    'event_bus.emit("cutscene:start"', "audio_manager.begin_cutscene_sfx_capture()",
    "scene_manager_api.begin_cutscene_staging", "_save_and_transition_returning_cross_scene",
    "_execute_steps", "world_epoch != world_epoch_at_start", "_cleanup(was_skipping)",
    'event_bus.emit("cutscene:end"',
]), "Godot CutsceneManager start/audio/staging/execute/cleanup order drift")
require("_cleanup(true)" in section(cutscene_manager, "func deserialize(", "func destroy("), "Godot CutsceneManager deserialize does not stop captured cutscene SFX")
require("_cleanup(true)" in section(cutscene_manager, "func destroy(", "func _on_click_bound("), "Godot CutsceneManager destroy does not stop captured cutscene SFX")
require("cutscene_renderer.add_to_entity_layer(npc.container)" in cutscene_manager, "Godot CutsceneManager bypasses CutsceneRenderer entity-layer ownership")
ts_cutscene_show_img = section(ts_cutscene_renderer, "async showImg(", "async showPercentImg(")
gd_cutscene_show_img = gd_function(gd_cutscene_renderer, "show_img")
require(ordered_tokens(ts_cutscene_show_img, [
    "texture = await this.assetManager.loadTexture(resolvedPath)", "const sprite = new Sprite(texture)",
    "this.hideImg(id)", "this.renderer.cutsceneOverlay.addChild(sprite)", "this.images.set(id",
]), "TypeScript CutsceneRenderer showImg load/replace/mount order drift")
require(ordered_tokens(gd_cutscene_show_img, [
    "var texture: Variant = _load_texture_safely(path)", "if not texture is Texture2D: return false",
    "var node := TextureRect.new()", "hide_img(id)", "renderer.cutscene_overlay.add_child(node)", "images[id] = node",
]), "Godot CutsceneRenderer showImg must replace every source handle after the new texture is ready")
require(gd_cutscene_show_img.count("hide_img(id)") == 1 and "if id == ANON_SHOT_ID" not in gd_cutscene_show_img,
        "Godot CutsceneRenderer showImg retains the old anonymous-only replacement branch that leaks named VFX layers")

require(ordered_tokens(ts_save_manager, [
    "private collector", "private distributor", "private sceneReloader",
    "private fallbackScene", "private strings", "private canSave", "constructor(",
    "setFallbackScene(", "setCanSavePredicate(", "save(", "load(",
    "getSlotMeta(", "hasSave(", "deleteSlot(", "hasAnySave(",
    "exportSlotPayload(", "importSlotPayload(",
]), "TypeScript SaveManager field/method architecture drift")
require(ordered_tokens(gd_save_manager, [
    "var _collector", "var _distributor", "var _scene_reloader",
    "var _fallback_scene", "var _strings", "var _can_save", "func _init(",
    "func set_fallback_scene(", "func set_can_save_predicate(", "func save(",
    "func load(", "func get_slot_meta(", "func has_save(", "func delete_slot(",
    "func has_any_save(", "func export_slot_payload(", "func import_slot_payload(",
]), "Godot SaveManager field/method architecture/order drift")
ts_save_fields = re.findall(r"^  private ([A-Za-z_][A-Za-z0-9_]*)\s*:", ts_save_manager, flags=re.MULTILINE)
gd_save_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_save_manager, flags=re.MULTILINE)
require(ts_save_fields == ["collector", "distributor", "sceneReloader", "fallbackScene", "strings", "canSave"], f"TypeScript SaveManager field ownership drift: {ts_save_fields}")
require(gd_save_fields == ["_collector", "_distributor", "_scene_reloader", "_fallback_scene", "_strings", "_can_save"], f"Godot SaveManager field ownership drift: {gd_save_fields}")
gd_save_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)\(", gd_save_manager, flags=re.MULTILINE)
require(gd_save_methods == [
    "_init", "set_fallback_scene", "set_can_save_predicate", "save", "load",
    "get_slot_meta", "has_save", "delete_slot", "has_any_save",
    "export_slot_payload", "import_slot_payload",
], f"Godot SaveManager method surface drift: {gd_save_methods}")
for forbidden_save_member in [
    "_storage_root", "_destroyed", "_operation_epoch", "last_error", "func destroy(",
    "func _rollback(", "func _read_payload(", "func _write_payload_atomic(",
    "func _slot_path(", "func _scene_id(", "func _valid_slot(", "func read_slot_payload(",
]:
    require(forbidden_save_member not in gd_save_manager, f"Godot SaveManager invented non-source ownership/API: {forbidden_save_member}")
require("FileAccess" not in gd_save_manager and "DirAccess" not in gd_save_manager, "Godot SaveManager owns filesystem mechanics instead of translating localStorage calls")
require(all(token in gd_save_manager for token in [
    "RuntimeLocalStorageScript.get_item", "RuntimeLocalStorageScript.set_item",
    "RuntimeLocalStorageScript.remove_item",
]), "Godot SaveManager does not route browser localStorage primitives through one engine adapter")
require(ordered_tokens(gd_local_storage, [
    "static func get_item(", "static func set_item(", "static func remove_item(",
]), "Godot localStorage engine adapter API/order drift")
require("FileAccess" in gd_local_storage and "DirAccess" in gd_local_storage, "Godot localStorage adapter does not own persistence mechanics")
require(any(adapter.get("target") == "godot_port/scripts/runtime/local_storage.gd" for adapter in CODE_TRANSLATION_CONTRACT.get("engineAdapters", [])), "code translation contract does not declare the localStorage engine adapter")
save_wiring = section(bootstrap, "save_manager = RuntimeSaveManager.new(", "save_manager.set_can_save_predicate")
require(ordered_tokens(save_wiring, [
    'Callable(self, "collect_save_data")', 'Callable(self, "distribute_save_data")',
    'Callable(self, "reload_saved_scene")', "strings_provider", 'game_config.get("fallbackScene"',
]), "Godot Game SaveManager constructor dependency/order drift")
require(ordered_tokens(game_start, [
    "_register_ui_panels()", "wire_text_resolve()", "save_manager.set_fallback_scene(",
    'await setup_player({"deferAvatar": is_dev_mode})',
]), "Godot Game SaveManager fallback/setupPlayer startup phase drift")
require("storage_root" not in save_wiring and "RuntimeLocalStorage" not in save_wiring, "Godot Game injects a non-source storage dependency into SaveManager")
require("save_manager.destroy" not in bootstrap, "Godot Game calls an invented SaveManager lifecycle API")
require("saves.export_slot_payload(slot)" in gd_menu_ui and "saves.import_slot_payload(slot, file.get_as_text())" in gd_menu_ui, "Godot MenuUI does not preserve SaveManager raw-string import/export boundary")
require("FileAccess.open" in gd_menu_ui, "Godot MenuUI does not own the platform file chooser payload transfer like TypeScript MenuUI")

expected_systems = CONTRACT["registeredSystems"]
ts_system_block = section(game, "this.registeredSystems = [", "];\n    for (const entry")
ts_systems = re.findall(r"name:\s*'([^']+)'", ts_system_block)
gd_system_block = section(bootstrap, "registered_systems = [", "]\n\tif not runtime_root.attach_system_slots")
gd_systems = re.findall(r'"name":\s*"([^"]+)"', gd_system_block)
require(ts_systems == expected_systems, f"TypeScript registeredSystems drift: {ts_systems}")
require(gd_systems == expected_systems, f"Godot registeredSystems order drift: {gd_systems}")
require('{"name": "cutsceneManager", "system": null}' in gd_system_block, "Godot registeredSystems must retain the source constructor-time CutsceneManager null slot")
require(ordered_tokens(bootstrap, [
    "runtime_root.attach_system_slots(registered_systems)", "for entry: Dictionary in registered_systems:",
    "entry.system.init(game_context)", "cutscene_manager = RuntimeCutsceneManager.new(",
    "cutscene_manager.init(game_context)", "registered_systems.find_custom(",
    'entry.name == "cutsceneManager"', "registered_systems[cutscene_system_index].system = cutscene_manager",
    'runtime_root.replace_registered_system("cutsceneManager", cutscene_manager)',
]), "Godot Game registeredSystems init/CutsceneManager replacement ownership drift")
require("func() -> Node" not in gd_system_block, "Godot system assembly regressed to factory registration")
require("func attach_system_slots(source_slots: Array[Dictionary])" in runtime_root, "RuntimeRoot parenting adapter must accept Game-owned explicit system slots")
require("factory" not in re.sub(r"#.*", "", runtime_root) and "func get_system" not in runtime_root, "RuntimeRoot still owns a factory/service-locator path")
require("runtime_root.get_system" not in bootstrap, "bootstrap still looks up systems through RuntimeRoot instead of retaining explicit instances")
for forbidden_runtime_root_owner in ["init_runtime(", "serialize_systems(", "deserialize_systems(", "destroy_runtime("]:
    require(f"runtime_root.{forbidden_runtime_root_owner}" not in bootstrap, f"Godot Game delegates source registeredSystems lifecycle to RuntimeRoot: {forbidden_runtime_root_owner}")

expected_events = CONTRACT["eventBridgeEvents"]
ts_events = re.findall(r"this\.listen\('([^']+)'", ts_bridge)
gd_events = re.findall(r'_listen\("([^"]+)"', gd_bridge)
require(ts_events == expected_events, f"TypeScript EventBridge event set drift: {ts_events}")
require(gd_events == expected_events, f"Godot RuntimeEventBridge event set/order drift: {gd_events}")
exclusive_bridge_events = {
    "shop:purchase", "inventory:discard", "shop:closed", "map:travel",
    "menu:newGame", "menu:returnToMain", "menu:resume", "scene:enter", "ruleUse:apply",
}
for event in exclusive_bridge_events:
    require(not re.search(rf'event_bus\.on\("{re.escape(event)}"', bootstrap), f"bootstrap illegally owns EventBridge event: {event}")
require(not (PORT / "scripts/core/dialogue_event_bridge.gd").exists(), "partial DialogueEventBridge must not coexist with RuntimeEventBridge")
ts_event_deps = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+):", section(ts_bridge, "export interface EventBridgeDeps", "export class EventBridge"), flags=re.MULTILINE)
gd_event_wiring = section(bootstrap, "event_bridge = RuntimeEventBridge.new", "event_bridge.init()")
gd_event_deps = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_event_wiring, flags=re.MULTILINE)
require(ts_event_deps == CONTRACT["eventBridgeDependencies"], f"TypeScript EventBridgeDeps drift: {ts_event_deps}")
require(gd_event_deps == CONTRACT["eventBridgeDependencies"], f"Godot EventBridge dependency shape/order drift: {gd_event_deps}")
require("restartRuntimeForNewGame" not in bootstrap and "restart_runtime_for_new_game" not in gd_bridge, "Godot EventBridge restart ownership drift")
require(ordered_tokens(ts_bridge, [
    "private eventBus", "private deps", "private boundCallbacks",
    "private hasStartedSession", "constructor(", "init(",
    "restartPageForNewGame(", "listen(", "destroy(",
]), "TypeScript EventBridge field/method architecture drift")
require(ordered_tokens(gd_bridge, [
    "var _event_bus", "var _deps", "var _bound_callbacks",
    "var _has_started_session", "func _init(", "func init(",
    "func _restart_page_for_new_game(", "func _listen(", "func destroy(",
]), "Godot EventBridge field/method architecture/order drift")
gd_bridge_top_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_bridge, flags=re.MULTILINE)
require(gd_bridge_top_fields == ["_event_bus", "_deps", "_bound_callbacks", "_has_started_session"], f"Godot EventBridge field ownership drift: {gd_bridge_top_fields}")
for forbidden in ["var _destroyed", "func has_started_session(", "func _on_", "guard_map_travel =", '_deps.get("guardMapTravel"']:
    require(forbidden not in gd_bridge, f"Godot EventBridge exposes a non-source responsibility/API: {forbidden}")
require("_deps.guardMapTravel.call()" in gd_bridge, "Godot EventBridge weakens required guardMapTravel dependency")
require('{"event": event, "fn": fn}' in gd_bridge and "binding.fn" in gd_bridge and "_bound_callbacks = []" in gd_bridge, "Godot EventBridge listener ownership/lifecycle drift")
require("Engine.get_main_loop().reload_current_scene()" in section(gd_bridge, "func _restart_page_for_new_game", "func _listen"), "Godot EventBridge does not own the hard-session restart counterpart")
require("func _on_" not in gd_bridge and 'Callable(self, "_on_' not in gd_bridge, "Godot EventBridge moves source init closures into invented handler methods")
rule_use_bridge = section(gd_bridge, '_listen("ruleUse:apply"', "func _restart_page_for_new_game")
require('var result_text := str(payload.get("resultText", ""))' in rule_use_bridge and "if not result_text.is_empty():" in rule_use_bridge, "Godot EventBridge changes source truthy resultText semantics")

require(bootstrap.count("RuntimeActionRegistryScript.register_action_handlers(action_executor, {") == 1, "bootstrap must have exactly one file-level ActionRegistry composition entry")
require("RuntimeActionRegistryScript.new" not in bootstrap, "Godot must not turn the file-level TypeScript ActionRegistry module into an instance")
require(not re.search(r"^var _(?:event_bus|state_controller):", action_registry, flags=re.MULTILINE), "Godot ActionRegistry retains dependencies outside ActionRegistryDeps")
require(not re.search(r"action_executor\.(?:register_|set_choose|set_random|set_pickup|add_post)", bootstrap), "bootstrap still performs distributed ActionExecutor wiring")
require("static func register_action_handlers" in action_registry, "RuntimeActionRegistry file-level composition entry missing")
domain_registration = re.findall(r"^func (register_[a-z0-9_]+)", action_executor, flags=re.MULTILINE)
require(not domain_registration, f"ActionExecutor still owns domain handler registration: {domain_registration}")
group_registration = re.findall(r"^(?:static )?func (register_[a-z0-9_]+_handlers?)", action_registry, flags=re.MULTILINE)
require(group_registration == ["register_action_handlers"], f"Godot ActionRegistry invented domain registration groups: {group_registration}")
for forbidden in ["ACTION_REGISTRATION_ORDER", "_staged_handlers", "_commit_staged_handlers", "add_post_action_hook"]:
    require(forbidden not in action_registry, f"Godot ActionRegistry retains non-source staging/hook architecture: {forbidden}")
ts_action_deps_block = section(read("src/core/ActionRegistry.ts"), "export interface ActionRegistryDeps", "export function registerActionHandlers")
ts_action_deps = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+)(?:\?)?:", ts_action_deps_block, flags=re.MULTILINE)
gd_action_wiring = section(bootstrap, "RuntimeActionRegistryScript.register_action_handlers(action_executor, {", "\n\t})")
gd_action_deps = re.findall(r'^\t\t"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_action_wiring, flags=re.MULTILINE)
require(ts_action_deps == CONTRACT["actionRegistryDependencies"], f"TypeScript ActionRegistryDeps drift: {ts_action_deps}")
require(gd_action_deps == CONTRACT["actionRegistryDependencies"], f"Godot ActionRegistry dependency shape/order drift: {gd_action_deps}")
for method in ["show_overlay_image", "hide_overlay_image", "blend_overlay_image"]:
    require(f'Callable(cutscene_manager, "{method}")' in gd_action_wiring, f"Godot Game bypasses CutsceneManager.{method} ownership")
for forbidden in ["d.player", "d.camera", "d.graphDialogueManager", "d.inputManager", "d.renderer", "d.sceneDepthSystem", "d.debugAlert"]:
    require(forbidden not in section(action_registry, "static func register_action_handlers", "static func audit_action_registrations"), f"Godot ActionRegistry bypasses high-level dependency contract: {forbidden}")
ts_action_types = re.findall(r"executor\.register\(\s*'([^']+)'", read("src/core/ActionRegistry.ts"))
gd_action_types = re.findall(r'executor\.register\(\s*"([^"]+)"', action_registry)
ts_action_registrations = extract_action_registrations(read("src/core/ActionRegistry.ts"))
gd_action_registrations = extract_action_registrations(action_registry)
expected_action_types = CONTRACT["registeredActions"]
require(ts_action_types == expected_action_types, f"TypeScript ActionRegistry action order drift: {ts_action_types}")
require(gd_action_types == expected_action_types, f"Godot ActionRegistry direct registration order drift: {gd_action_types}")
require(len(ts_action_types) == 97 and len(set(ts_action_types)) == 97, f"TypeScript ActionRegistry action set drift: {len(ts_action_types)}")
require(set(gd_action_types) == set(ts_action_types) and len(gd_action_types) == 97, f"Godot ActionRegistry action set drift: missing={sorted(set(ts_action_types) - set(gd_action_types))}, extra={sorted(set(gd_action_types) - set(ts_action_types))}")
registration_param_drift = [
    (index, ts_value, gd_value)
    for index, (ts_value, gd_value) in enumerate(zip(ts_action_registrations, gd_action_registrations))
    if ts_value != gd_value
]
if len(ts_action_registrations) != len(gd_action_registrations):
    registration_param_drift.append(("length", len(ts_action_registrations), len(gd_action_registrations)))
require(not registration_param_drift, f"Godot ActionRegistry type/paramNames translation drift: {registration_param_drift}")
require("d.get(\"debugPanelLog\")" in action_registry and "callback.call(\"[%s] %s\"" in action_registry, "Godot ActionRegistryDeps.debugPanelLog is not consumed")
require("_param_names_map[type] = names" in action_executor, "Godot zero-parameter actions must expose [] instead of unknown/null")
scripted_action = section(action_registry, 'executor.register("playScriptedDialogue"', 'executor.register("waitMs"')
require(all(token in scripted_action for token in ["resolveScriptedSpeaker", "resolveScriptedLineExtras", "stringsProvider", "resolveDisplayTextForPlayScripted"]), "Godot ActionRegistry does not own playScriptedDialogue normalization dependencies")
require("d.playScriptedDialogue.call(lines)" in scripted_action and ', ["lines"])' in scripted_action, "playScriptedDialogue callback/parameter protocol drift")
bootstrap_scripted = section(bootstrap, "func play_scripted_dialogue_from_action", "func _start_dialogue_graph_from_action")
require("params.get" not in bootstrap_scripted, "bootstrap still owns playScriptedDialogue action normalization")
require("dialogue_manager.play_and_wait" not in bootstrap_scripted, "Godot invents DialogueManager-owned scripted completion")
require(ordered_tokens(bootstrap_scripted, [
    "graph_dialogue_manager.is_active()", "state_controller.set_state(",
    "RuntimeAsyncLatch.new()", 'event_bus.on("dialogue:end", on_end)',
    "dialogue_manager.start_scripted_dialogue(lines, nested_in_graph)",
    "await completion.wait()",
]), "Godot Game scripted-dialogue Promise ownership/order drift")
require('payload.get("source") != "scripted"' in bootstrap_scripted, "Godot Game scripted-dialogue completion does not filter dialogue:end source")
require('event_bus.off("dialogue:end", on_end)' in bootstrap_scripted, "Godot Game scripted-dialogue completion leaks its EventBus listener")
require(all(token in gd_async_latch for token in ["signal resolved", "func resolve() -> void:", "func reject(", "func wait() -> bool:"]), "Godot Promise completion adapter contract drift")

ts_executor_methods = [
    "normalizeActionTypeKey", "constructor", "setResolveNotificationText", "registerBuiltinHandlers",
    "register", "getParamNames", "getRegisteredActionTypes", "getPolicyDepth", "pushActionPolicy",
    "popActionPolicy", "findBlockingPolicy", "hasHandler", "execute", "executeAwait",
    "executeBatchAwait", "executeBatchInZoneContext", "destroy", "runWithExploreActionLock",
]
gd_executor_methods = [
    "normalize_action_type_key", "_init", "set_resolve_notification_text", "_register_builtin_handlers",
    "register", "get_param_names", "get_registered_action_types", "get_policy_depth", "push_action_policy",
    "pop_action_policy", "_find_blocking_policy", "has_handler", "execute", "execute_await",
    "execute_batch_await", "execute_batch_in_zone_context", "destroy", "_run_with_explore_action_lock",
]
require(ordered_tokens(read("src/core/ActionExecutor.ts"), ts_executor_methods), "TypeScript ActionExecutor method architecture drift")
require(ordered_tokens(action_executor, [f"func {name}" for name in gd_executor_methods]), "Godot ActionExecutor method architecture/order drift")
for forbidden in ["post_action_hook", "lifecycle_epoch", "registration_group", "staged_handler"]:
    require(forbidden not in action_executor, f"Godot ActionExecutor invented non-source responsibility: {forbidden}")

ts_manifest_block = section(read("src/core/actionParamManifest.ts"), "export const ACTION_PARAM_MANIFEST", "\n};")
ts_manifest_keys = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+):", ts_manifest_block, flags=re.MULTILINE)
gd_manifest_block = section(action_param_manifest, "const ACTION_PARAM_MANIFEST", "\n}")
gd_manifest_keys = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_manifest_block, flags=re.MULTILINE)
require(gd_manifest_keys == ts_manifest_keys, f"Godot actionParamManifest module/order drift: {gd_manifest_keys}")
require("static func audit_action_registrations_against_manifest(executor: RuntimeActionExecutor)" in action_registry, "Godot ActionRegistry audit export/signature drift")
ts_narrative_validation = read("src/core/narrativeGraphValidation.ts")
gd_narrative_validation = read("godot_port/scripts/core/narrative_graph_validation.gd")
require(ordered_tokens(ts_narrative_validation, [
    "DEFAULT_NARRATIVE_DRAFT_SIGNAL", "DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX",
    "narrativeStateEnteredSignalKey(", "parseNarrativeDerivedStateSignal(",
    "isNarrativeDerivedStateSignal(", "isReservedNarrativeAuthorSignalId(",
    "narrativeStateBroadcastOnEnter(", "validateNarrativeGraphData(",
    "blockingNarrativeValidationErrors(", "resolveNarrativeEndpoint(",
    "narrativeEndpointLabel(", "normalizeValidationFile(", "compileGraphs(",
    "isGraph(", "buildGraphIndex(", "isElementKind(", "validateGraph(",
    "collectKnownSignals(", "validateTransitionSignal(", "validateReactiveTrigger(",
    "validateStateCommandTargets(", "validateOwnerBindings(",
    "validateBroadcastStateSignals(", "validateActivePlanes(",
    "validateSaveMigrations(", "isPlainRecord(", "collectListenerRefs(",
    "validateAuthorSignals(", "validateActions(", "validateConditions(",
    "validateConditionExpr(", "validateActionDef(", "addDuplicateIssue(",
    "addIssue(", "validateIdDelimiter(", "compositionTarget(",
    "graphTargetFromCtx(", "elementTarget(", "stateTargetFromCtx(",
    "transitionTargetFromCtx(", "signalTarget(", "compactTarget(",
    "stringList(", "parseStateCommandRef(",
]), "TypeScript narrativeGraphValidation module architecture drift")
require(ordered_tokens(gd_narrative_validation, [
    "DEFAULT_NARRATIVE_DRAFT_SIGNAL", "DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX",
    "static func narrative_state_entered_signal_key(",
    "static func parse_narrative_derived_state_signal(",
    "static func is_narrative_derived_state_signal(",
    "static func is_reserved_narrative_author_signal_id(",
    "static func narrative_state_broadcast_on_enter(",
    "static func validate_narrative_graph_data(",
    "static func blocking_narrative_validation_errors(",
    "static func resolve_narrative_endpoint(",
    "static func narrative_endpoint_label(",
    "static func _normalize_validation_file(", "static func _compile_graphs(",
    "static func _is_graph(", "static func _build_graph_index(",
    "static func _is_element_kind(", "static func _validate_graph(",
    "static func _collect_known_signals(", "static func _validate_transition_signal(",
    "static func _validate_reactive_trigger(",
    "static func _validate_state_command_targets(",
    "static func _validate_owner_bindings(",
    "static func _validate_broadcast_state_signals(",
    "static func _validate_active_planes(", "static func _validate_save_migrations(",
    "static func _is_plain_record(", "static func _collect_listener_refs(",
    "static func _validate_author_signals(", "static func _validate_actions(",
    "static func _validate_conditions(", "static func _validate_condition_expr(",
    "static func _validate_action_def(", "static func _add_duplicate_issue(",
    "static func _add_issue(", "static func _validate_id_delimiter(",
    "static func _composition_target(", "static func _graph_target_from_context(",
    "static func _element_target(", "static func _state_target_from_context(",
    "static func _transition_target_from_context(", "static func _signal_target(",
    "static func _compact_target(", "static func _string_list(",
    "static func _parse_state_command_ref(",
]), "Godot narrativeGraphValidation module architecture/order drift")
require("RuntimeActionParamManifestScript.get_action_param_manifest(type)" in gd_narrative_validation, "Godot narrativeGraphValidation bypasses translated actionParamManifest")
require("RuntimeNarrativeGraphValidation.validate_narrative_graph_data" in read("godot_port/tests/narrative_graph_validation_test.gd"), "Godot narrativeGraphValidation lacks executable parity coverage")
ts_narrative_state = read("src/core/NarrativeStateManager.ts")
gd_narrative_state = read("godot_port/scripts/systems/narrative_state_manager.gd")
require(ordered_tokens(ts_narrative_state, [
    "private eventBus", "private flagStore", "private actionExecutor",
    "private conditionCtxFactory", "private graphs", "private activeStates",
    "private ownerIndex", "private queue", "private completedQueueItems",
    "private draining", "private drainPromise", "private nestedDrainPromises",
    "private runningActionsDepth", "private drainStepCount", "private destroyed",
    "private reactiveEvalScheduled", "private readonly onFlagChangedListener",
    "private recentTransitions", "private reachedStates", "private recentIssues",
    "private saveMigrations", "private listenedSignalKeysCache",
    "private reportedUnlistenedSignalKeys", "private recentTrace", "private traceSeq",
    "private primaryOwnerWarningKeys", "private validationMode",
]), "TypeScript NarrativeStateManager field architecture drift")
require(ordered_tokens(gd_narrative_state, [
    "var _event_bus", "var _flag_store", "var _action_executor",
    "var _condition_context_factory", "var _graphs", "var _active_states",
    "var _owner_index", "var _queue", "var _completed_queue_items",
    "var _draining", "var _drain_promise", "var _nested_drain_promises",
    "var _running_actions_depth", "var _drain_step_count", "var _destroyed",
    "var _reactive_eval_scheduled", "var _on_flag_changed_listener",
    "var _recent_transitions", "var _reached_states", "var _recent_issues",
    "var _save_migrations", "var _listened_signal_keys_cache",
    "var _reported_unlistened_signal_keys", "var _recent_trace", "var _trace_seq",
    "var _primary_owner_warning_keys", "var _validation_mode",
]), "Godot NarrativeStateManager field architecture/order drift")
require(ordered_tokens(ts_narrative_state, [
    "constructor(", "stateEnteredSignalKey(", "graphStateEnteredKey(",
    "normalizeTriggerKey(", "triggerKeysEqual(", "init(", "update(",
    "setConditionEvalContextFactory(", "setRuntimeValidationMode(",
    "loadFromAsset(", "setSaveMigrations(", "registerGraphs(",
    "kickReactiveEvaluation(", "handleFlagChanged(", "startDetachedDrain(",
    "getActiveState(", "isStateActive(", "hasReachedState(", "markStateReached(",
    "getGraph(", "classifyStateRef(", "getGraphs(", "getGraphIdsByOwner(",
    "getGraphsByOwner(", "getActiveStatesByOwner(", "getPrimaryGraphByOwner(",
    "getPrimaryActiveStateByOwner(", "isOwnerStateActive(",
    "emitNarrativeSignal(", "enqueueTriggerKey(", "debugSetNarrativeState(",
    "setNarrativeState(", "serialize(", "deserialize(",
    "resetStatesToRegisteredBaseline(", "restoreActiveStates(",
    "restoreReachedStates(", "migrateSaveGraphId(", "migrateSaveStateId(",
    "migrationSuffix(", "warnDroppedSaveEntry(", "destroy(", "debugSnapshot(",
    "clearDebugTrace(", "ownerKey(", "indexGraphOwner(",
    "recordDuplicateOwnerBindings(", "recordPrimaryOwnerAmbiguous(",
    "normalizeSignal(", "enqueue(", "consumeDiscardedRejection(", "drainQueue(",
    "drainNestedQueue(", "runNestedDrainLoop(", "drainAvailableQueue(",
    "resolveCompletedQueueItems(", "rejectQueuedItems(", "processQueueItem(",
    "processTrigger(", "getListenedSignalKeys(", "reportUnlistenedSignal(",
    "conditionsMet(", "evaluateReactiveTriggers(", "evaluateReactiveConditions(",
    "processReactiveTrigger(", "applyStateCommand(", "applyTransition(",
    "enterState(", "enqueueGraphStateEntered(", "isLocalEndpoint(",
    "recordUnsupportedEndpoint(", "runActions(", "isScenarioGraph(",
    "canRemoteEnterState(", "canLeaveGraphRemotely(", "recordIssue(",
    "recordTrace(", "tracePatchForTrigger(", "isDevRuntime(",
    "defaultRuntimeValidationMode(", "validateLoadedData(",
    "recordValidationIssue(", "compileNarrativeGraphs(", "isNarrativeGraph(",
]), "TypeScript NarrativeStateManager method architecture drift")
require(ordered_tokens(gd_narrative_state, [
    "func _init(", "static func state_entered_signal_key(",
    "static func graph_state_entered_key(", "static func normalize_trigger_key(",
    "static func trigger_keys_equal(", "func init(", "func update(",
    "func set_condition_eval_context_factory(", "func set_runtime_validation_mode(",
    "func load_from_asset(", "func set_save_migrations(", "func register_graphs(",
    "func _kick_reactive_evaluation(", "func _handle_flag_changed(",
    "func _start_detached_drain(", "func get_active_state(",
    "func is_state_active(", "func has_reached_state(",
    "func _mark_state_reached(", "func get_graph(", "func classify_state_ref(",
    "func get_graphs(", "func get_graph_ids_by_owner(",
    "func get_graphs_by_owner(", "func get_active_states_by_owner(",
    "func get_primary_graph_by_owner(", "func get_primary_active_state_by_owner(",
    "func is_owner_state_active(", "func emit_narrative_signal(",
    "func enqueue_trigger_key(", "func debug_set_narrative_state(",
    "func set_narrative_state(", "func serialize(", "func deserialize(",
    "func _reset_states_to_registered_baseline(", "func restore_active_states(",
    "func _restore_reached_states(", "func _migrate_save_graph_id(",
    "func _migrate_save_state_id(", "func _migration_suffix(",
    "func _warn_dropped_save_entry(", "func destroy(", "func debug_snapshot(",
    "func clear_debug_trace(", "func _owner_key(", "func _index_graph_owner(",
    "func _record_duplicate_owner_bindings(",
    "func _record_primary_owner_ambiguous(", "func _normalize_signal(",
    "func _enqueue(", "func _consume_discarded_rejection(", "func _drain_queue(",
    "func _drain_nested_queue(", "func _run_nested_drain_loop(",
    "func _drain_available_queue(", "func _resolve_completed_queue_items(",
    "func _reject_queued_items(", "func _process_queue_item(",
    "func _process_trigger(", "func _get_listened_signal_keys(",
    "func _report_unlistened_signal(", "func _conditions_met(",
    "func _evaluate_reactive_triggers(", "func _evaluate_reactive_conditions(",
    "func _process_reactive_trigger(", "func _apply_state_command(",
    "func _apply_transition(", "func _enter_state(",
    "func _enqueue_graph_state_entered(", "func _is_local_endpoint(",
    "func _record_unsupported_endpoint(", "func _run_actions(",
    "func _is_scenario_graph(", "func _can_remote_enter_state(",
    "func _can_leave_graph_remotely(", "func _record_issue(",
    "func _record_trace(", "func _trace_patch_for_trigger(",
    "func _is_dev_runtime(", "func _default_runtime_validation_mode(",
    "func _validate_loaded_data(", "func _record_validation_issue(",
    "static func compile_narrative_graphs(", "static func _is_narrative_graph(",
]), "Godot NarrativeStateManager method architecture/order drift")
for forbidden_narrative_member in [
    "_asset_manager", "nested_drain_completed", "_nested_drain_active",
    "debug_snapshot_fragment", "graph_count", "RuntimeNarrativeGraphCompiler",
]:
    require(forbidden_narrative_member not in gd_narrative_state, f"Godot NarrativeStateManager retains non-source responsibility/API: {forbidden_narrative_member}")
require("func load_from_asset(asset_manager: RuntimeAssetManager" in gd_narrative_state, "Godot NarrativeStateManager incorrectly owns AssetManager instead of receiving loadFromAsset dependency")
require("RuntimeNarrativeGraphValidationScript.validate_narrative_graph_data(data)" in gd_narrative_state, "Godot NarrativeStateManager bypasses translated narrativeGraphValidation")
require("Vite does" in gd_narrative_state and "not inject `env` on that indirect object" in gd_narrative_state, "Godot NarrativeStateManager lost the source import.meta alias semantics adapter")
require("OS.is_debug_build()" not in gd_narrative_state, "Godot NarrativeStateManager incorrectly substitutes the engine debug bit for the source's indirect import.meta.env access")
require("RuntimeAsyncLatch.new()" in gd_narrative_state and "_completed_queue_items" in gd_narrative_state, "Godot NarrativeStateManager does not preserve queued-item/drain Promise ownership")
require("queueMicrotask" in ts_narrative_state, "TypeScript narrative reactive scheduling architecture drift")
require("RuntimeMicrotaskQueueScript.queue_microtask" in gd_narrative_state, "Godot narrative manager bypasses the JS microtask platform adapter")
require("queueMicrotask" in read("src/systems/ArchiveManager.ts"), "TypeScript archive unlock scheduling architecture drift")
require("RuntimeMicrotaskQueueScript.queue_microtask" in read("godot_port/scripts/systems/archive_manager.gd"), "Godot archive manager bypasses the JS microtask platform adapter")
require(ordered_tokens(ts_archive_manager, [
    "private eventBus", "private flagStore", "private characterDefs", "private loreDefs", "private documentDefs",
    "private bookDefs", "private bookEntryIds", "private itemDisplayNames", "private unlockedCharacters",
    "private unlockedLore", "private unlockedDocuments", "private unlockedBooks", "private readEntries",
    "private firstViewFired", "private loreCategoryNames", "private strings", "private assetManager",
    "private conditionCtxFactory", "private onFlagChanged", "private resolveForDisplay", "private restoring",
    "private seeding", "private unlockEvalScheduled", "private unlockEvalRunning", "private unlockEvalDirty",
    "private destroyed", "private preloadIdleHandle", "constructor(", "private scheduleUnlockEval(",
    "private runUnlockEvalToConvergence(", "init(", "setConditionEvalContextFactory(", "setRestoring(",
    "setResolveForDisplay(", "resolveLine(", "getItemDisplayNames(", "private rd(", "update(",
    "async loadDefs(", "private scheduleContentImagePreload(", "private syncUnlockedBooksFromFlags(",
    "private async preloadContentImages(", "private async loadTexturesPooled(", "private async loadCharacters(",
    "private async loadLore(", "private async loadDocuments(", "private async loadBooks(",
    "private async loadItemDisplayNames(", "addEntry(", "private emitUpdate(", "markRead(", "isRead(",
    "triggerFirstViewIfNeeded(", "triggerBookSliceFirstView(", "getLoreCategoryName(", "hasUnread(",
    "private evaluateUnlocks(", "private checkConditions(", "getUnlockedCharacters(",
    "getCharacterVisibleImpressions(", "getCharacterVisibleInfo(", "getUnlockedLore(",
    "getUnlockedDocuments(", "getBooks(", "getUnlockedBooks(", "getBookTocChapters(",
    "getBookPageSlice(", "getBookEntrySlice(", "serialize(", "deserialize(", "destroy(",
]), "TypeScript ArchiveManager field/method architecture drift")
require(ordered_tokens(gd_archive_manager, [
    "var _event_bus", "var _flag_store", "var _character_defs", "var _lore_defs", "var _document_defs",
    "var _book_defs", "var _book_entry_ids", "var _item_display_names", "var _unlocked_characters",
    "var _unlocked_lore", "var _unlocked_documents", "var _unlocked_books", "var _read_entries",
    "var _first_view_fired", "var _lore_category_names", "var _strings", "var _asset_manager",
    "var _condition_context_factory", "var _on_flag_changed", "var _resolve_for_display", "var _restoring",
    "var _seeding", "var _unlock_eval_scheduled", "var _unlock_eval_running", "var _unlock_eval_dirty",
    "var _destroyed", "var _preload_idle_handle", "func _init(", "func _schedule_unlock_eval(",
    "func _run_unlock_eval_to_convergence(", "func init(", "func set_condition_eval_context_factory(",
    "func set_restoring(", "func set_resolve_for_display(", "func resolve_line(",
    "func get_item_display_names(", "func _rd(", "func update(", "func load_defs(",
    "func _schedule_content_image_preload(", "func _sync_unlocked_books_from_flags(",
    "func _preload_content_images(", "func _load_textures_pooled(", "func _load_characters(",
    "func _load_lore(", "func _load_documents(", "func _load_books(", "func _load_item_display_names(",
    "func add_entry(", "func _emit_update(", "func mark_read(", "func is_read(",
    "func trigger_first_view_if_needed(", "func trigger_book_slice_first_view(",
    "func get_lore_category_name(", "func has_unread(", "func _evaluate_unlocks(",
    "func _check_conditions(", "func get_unlocked_characters(", "func get_character_visible_impressions(",
    "func get_character_visible_info(", "func get_unlocked_lore(", "func get_unlocked_documents(",
    "func get_books(", "func get_unlocked_books(", "func get_book_toc_chapters(",
    "func get_book_page_slice(", "func get_book_entry_slice(", "func serialize(",
    "func deserialize(", "func destroy(",
]), "Godot ArchiveManager field/method architecture/order drift")
for forbidden_archive_member in ["func get_asset_manager(", "func definition_counts(", "func debug_snapshot_fragment(", "func _load_list(", "func _unlock_defined(", "func _unlock_auto("]:
    require(forbidden_archive_member not in gd_archive_manager, f"Godot ArchiveManager retains non-source responsibility/API: {forbidden_archive_member}")
require("func load_defs() -> void:" in gd_archive_manager and "if not archive_manager.load_defs()" not in bootstrap, "Godot ArchiveManager changes source loadDefs completion/failure contract")
require(all(token in gd_archive_manager for token in [
    "SceneTreeTimer", "tree.create_timer(1.5)", "_preload_idle_handle.timeout.disconnect",
    "RuntimeResourceLocator.get_default().media_url_from_short_path", "_load_textures_pooled(paths.keys(), 3)",
]), "Godot ArchiveManager content-image idle preload/cancellation translation drift")
for ui_name, gd_ui in [("CharacterBookUI", gd_character_book_ui), ("LoreBookUI", gd_lore_book_ui), ("DocumentBoxUI", gd_document_box_ui), ("BookReaderUI", gd_book_reader_ui)]:
    require("var asset_manager: RuntimeAssetManager" in gd_ui and "asset_manager.load_texture(" in gd_ui, f"Godot {ui_name} does not retain its source AssetManager dependency")
require("flush_scheduled_" not in read("godot_port/scripts/systems/archive_manager.gd") + read("godot_port/scripts/systems/narrative_state_manager.gd"), "Godot retains non-source public flush hooks")
require("await Promise.resolve(handler(action.params, zoneContext))" in read("src/core/ActionExecutor.ts"), "TypeScript ActionExecutor Promise continuation architecture drift")
require("await RuntimeMicrotaskQueueScript.yield_turn()" in action_executor, "Godot translated ActionExecutor bypasses the Promise continuation adapter")
require("static func yield_turn()" in gd_microtask_queue and "RuntimeAsyncLatch.new()" in gd_microtask_queue, "Godot Promise continuation adapter contract drift")
require("static func _schedule_flush()" in gd_microtask_queue and "scheduled.call_deferred()" in gd_microtask_queue, "Godot JS microtask adapter does not auto-drain outside translated await boundaries")
require("const prev = this.zoneActionTail.get(zoneId) ?? Promise.resolve()" in ts_zone_system, "TypeScript ZoneSystem Promise-tail scheduling architecture drift")
require("RuntimeMicrotaskQueueScript.queue_microtask" in gd_zone_system, "Godot ZoneSystem bypasses the JS microtask platform adapter")
require('call_deferred("_drain_actions"' not in gd_zone_system, "Godot ZoneSystem regressed to an engine deferred task instead of a JS microtask")
require(ordered_tokens(ts_zone_system, [
    "private eventBus", "private flagStore", "private actionExecutor", "private ruleOfferRegistry",
    "private conditionCtxFactory", "private zones", "private activeZoneIds", "private playerPosGetter",
    "private zoneStayNextAt", "private static readonly STAY_INTERVAL_SEC", "private zoneActionTail",
    "constructor(", "init(_ctx", "setConditionEvalContextFactory", "private evalZoneConditions",
    "setPlayerPositionGetter", "serialize()", "deserialize(", "setZones(", "getActiveZones",
    "clearActiveZonesForRestore", "clearZones", "update(_dt", "private enqueueZoneActions",
    "private enterZone", "private exitZone", "private emitRuleAvailability", "getCurrentRuleSlots",
    "isInAnyZone", "getActiveZoneIds", "destroy()",
]), "TypeScript ZoneSystem field/method architecture drift")
zone_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_zone_system, flags=re.MULTILINE)
zone_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_zone_system, flags=re.MULTILINE)
require(zone_fields == [
    "event_bus", "flag_store", "action_executor", "rule_offer_registry", "condition_ctx_factory", "zones",
    "active_zone_ids", "player_pos_getter", "zone_stay_next_at", "zone_action_tail",
], f"Godot ZoneSystem field architecture/order drift: {zone_fields}")
require(zone_methods == [
    "_init", "init", "set_condition_eval_context_factory", "_eval_zone_conditions",
    "set_player_position_getter", "serialize", "deserialize", "set_zones", "get_active_zones",
    "clear_active_zones_for_restore", "clear_zones", "update", "_enqueue_zone_actions", "_enter_zone",
    "_exit_zone", "_emit_rule_availability", "get_current_rule_slots", "is_in_any_zone",
    "get_active_zone_ids", "destroy",
], f"Godot ZoneSystem method architecture/order drift: {zone_methods}")
zone_set = gd_function(gd_zone_system, "set_zones")
require(ordered_tokens(zone_set, [
    "var next_ids", "for zone: Dictionary in next_zones", "for id: String in active_zone_ids.keys()",
    "_exit_zone(old_zone)", "active_zone_ids.erase(id)", "var slots_before", "rule_offer_registry.unregister",
    "var slots_after", "_emit_rule_availability()", "zones = next_zones", "zone_stay_next_at.keys()",
]) and "duplicate(" not in zone_set, "Godot ZoneSystem setZones reference/diff/offer order drift")
zone_update = gd_function(gd_zone_system, "update")
require(ordered_tokens(zone_update, [
    "player_pos_getter", "var position", "var player_x", "var player_y", "condition_ctx_factory.call()",
    "Time.get_ticks_usec()", 'zone.get("zoneKind") == "depth_floor"', 'zone.get("conditions")',
    "_eval_zone_conditions", "RuntimeZoneGeometry.is_valid_zone_polygon", "RuntimeZoneGeometry.is_point_in_polygon",
    "_enter_zone(zone)", "_exit_zone(zone)", 'zone.get("onStay")', "zone_stay_next_at.get",
    "zone_stay_next_at[zone.id]", "_enqueue_zone_actions", "execute_batch_in_zone_context",
]) and "update_enabled" not in gd_zone_system and "clock" not in gd_zone_system,
        "Godot ZoneSystem update/condition/geometry/stay order drift")
zone_enqueue = gd_function(gd_zone_system, "_enqueue_zone_actions")
require(ordered_tokens(zone_enqueue, [
    "zone_action_tail.get(zone_id)", "RuntimeAsyncTail.new()", "zone_action_tail[zone_id] = tail",
    "RuntimeMicrotaskQueueScript.queue_microtask", 'Callable(tail, "then").bind(task',
    '"ZoneSystem: zone',
]) and "func()" not in zone_enqueue, "Godot ZoneSystem Promise-tail/microtask/error topology drift")
require(all(token in gd_async_tail for token in [
    'func then(run: Callable, failure_warning: String = "")', '"failureWarning": failure_warning',
    "var result: Variant = await run.call()", "result == false", "push_warning(str(entry.failureWarning))",
    "run = Callable()", "entry.clear()",
]), "Godot Promise-tail adapter does not release settled reactions/report rejection-equivalent false")
require(all(token not in gd_zone_system for token in ["_action_queues", "_action_running", "_epoch", "wait_for_actions_idle", "_has_queued_actions", "set_update_enabled_getter", "set_clock_for_test"]),
        "Godot ZoneSystem retains target-only queue/control/test APIs")
require(ordered_tokens(gd_function(gd_zone_system, "get_active_zone_ids"), ["return active_zone_ids"]) and
        "active_zone_ids.keys()" not in gd_function(gd_zone_system, "get_active_zone_ids"),
        "Godot ZoneSystem getActiveZoneIds no longer returns its source-owned live Set equivalent")
require(ordered_tokens(gd_function(gd_zone_system, "destroy"), [
    "rule_offer_registry.clear()", "zones = []", "active_zone_ids.clear()", "zone_stay_next_at.clear()",
    "zone_action_tail.clear()",
]), "Godot ZoneSystem destroy ownership/order drift")

require(ordered_tokens(ts_zone_geometry, [
    "export function isPointInPolygon", "const n = polygon.length", "let inside = false",
    "Math.abs(dy) < 1e-12", "const xinters", "inside = !inside", "export function pointPolygonVerticalSide",
    "let yMin = Infinity", "let yMax = -Infinity", "let hitCount = 0", "Math.abs(dx) < 1e-12 ? 0.5",
    "if (hitCount === 0) return null", "if (py < yMin) return 'above'", "if (py > yMax) return 'below'",
    "export function isValidZonePolygon", "Number.isFinite(p.x)", "Number.isFinite(p.y)",
]), "TypeScript zoneGeometry function/order drift")
zone_geometry_methods = re.findall(r"^static func ([A-Za-z_][A-Za-z0-9_]*)", gd_zone_geometry, flags=re.MULTILINE)
require(zone_geometry_methods == ["is_point_in_polygon", "point_polygon_vertical_side", "is_valid_zone_polygon"],
        f"Godot zoneGeometry module surface/order drift: {zone_geometry_methods}")
require("_point_polygon_vertical_side" not in gd_renderer and "RuntimeZoneGeometry.point_polygon_vertical_side" in gd_renderer,
        "Godot Renderer duplicates imported zoneGeometry ownership")
require("RuntimeZoneSystem.is_valid_polygon" not in bootstrap + gd_depth_floor_zones + gd_zone_system and
        "RuntimeZoneSystem.is_point_in_polygon" not in bootstrap + gd_depth_floor_zones + gd_zone_system,
        "Godot zone geometry consumers still route through ZoneSystem")
require("set_update_enabled_getter" not in bootstrap, "Godot Game pushes source tick-state ownership into ZoneSystem")

require(ordered_tokens(ts_event_bus, [
    "private listeners", "private debugTraceEnabled", "private debugTraceLimit",
    "private debugTraceSeq", "private debugTrace", "on(", "off(", "emit(", "clear(",
    "enableDebugTrace(", "disableDebugTrace(", "clearDebugTrace(", "getDebugTrace(",
    "recordDebugTrace(", "function canonicalizeTraceValue", "function cloneTraceValue",
]), "TypeScript EventBus field/method architecture drift")
require(ordered_tokens(gd_event_bus, [
    "var _listeners", "var _debug_trace_enabled", "var _debug_trace_limit",
    "var _debug_trace_seq", "var _debug_trace", "func on(", "func off(", "func emit(",
    "func clear(", "func enable_debug_trace(", "func disable_debug_trace(",
    "func clear_debug_trace(", "func get_debug_trace(", "func _record_debug_trace(",
    "static func _canonicalize_trace_value", "static func _clone_trace_value",
]), "Godot EventBus field/method architecture/order drift")
require("func listener_count" not in gd_event_bus, "Godot EventBus exposes a non-source diagnostic API")
require("_listeners.erase(event)" not in gd_event_bus, "Godot EventBus.off changes the source map lifecycle")
require("_listeners.get(event, []).duplicate()" in gd_event_bus, "Godot EventBus.emit does not snapshot listeners before dispatch")

require(ordered_tokens(ts_flag_store, [
    "function normStaticVt", "private flags", "private eventBus", "private registryRuntime",
    "private conditionCtxFactory", "private warnedInvalidOps", "constructor(",
    "setConditionEvalContextFactory(", "configureRegistry(", "patternDefinesKey(",
    "isKeyAllowed(", "isKeyAllowedByRegistry(", "getDebugPickableKeys(",
    "getDebugValueKind(", "getRegistryValueType(", "appendStringFlag(",
    "addNumericFlag(", "set(", "get(", "evalPureFlagConjunction(",
    "isFlagOnlyAtom(", "checkConditions(", "looseEqual(", "toNum(",
    "compareOrder(", "serialize(", "deserialize(", "destroy(",
]), "TypeScript FlagStore field/method architecture drift")
require(ordered_tokens(gd_flag_store, [
    "var _flags", "var _event_bus", "var _registry_runtime",
    "var _condition_ctx_factory", "var _warned_invalid_ops", "func _init(",
    "func set_condition_eval_context_factory(", "func configure_registry(",
    "func _pattern_defines_key(", "func _is_key_allowed(",
    "func is_key_allowed_by_registry(", "func get_debug_pickable_keys(",
    "func get_debug_value_kind(", "func get_registry_value_type(",
    "func append_string_flag(", "func add_numeric_flag(", "func set_value(",
    "func get_value(", "func eval_pure_flag_conjunction(",
    "func _is_flag_only_atom(", "func check_conditions(", "func _loose_equal(",
    "func _to_number(", "func _compare_order(", "func serialize(",
    "func deserialize(", "func destroy(", "static func _norm_static_value_type(",
]), "Godot FlagStore field/method architecture/order drift")
for forbidden in ["func has_value(", "func registry_counts("]:
    require(forbidden not in gd_flag_store, f"Godot FlagStore exposes a non-source diagnostic API: {forbidden}")
for source_void_method in ["set_value", "append_string_flag", "add_numeric_flag"]:
    require(re.search(rf"func {source_void_method}\([^\n]+\) -> void:", gd_flag_store) is not None, f"Godot FlagStore changes source-void contract: {source_void_method}")
require("func get_registry_value_type(key: String) -> Variant:" in gd_flag_store, "Godot FlagStore registry type lookup cannot represent source null")
require(section(gd_flag_store, "func get_registry_value_type", "func append_string_flag").count("return null") == 2, "Godot FlagStore registry type lookup must return null for both source miss paths")
require('var operator := "==" if raw_operator == null else str(raw_operator)' in gd_flag_store,
        "Godot FlagStore lost source nullish cond.op ?? '==' semantics")
require(all(token in gd_flag_store for token in ['lower.begins_with("0x")', 'lower.begins_with("0b")', 'lower.begins_with("0o")', "static func _radix_number("]),
        "Godot FlagStore Number(string) translation omits JS hexadecimal/binary/octal forms")

require(ordered_tokens(ts_condition_evaluator, [
    "export function resolveNarrativeGraphRef(", "function isConditionLeaf(", "function isQuestLeaf(",
    "function isScenarioLeaf(", "function isScenarioLineLeaf(", "function isPlaneLeaf(",
    "function isNarrativeStateLeaf(", "function isAllNode(", "function isAnyNode(", "function isNotNode(",
    "function applyResolvedFlagConditionValue(", "function evalScenarioLeaf(", "function evalScenarioLineLeaf(",
    "function devReportDanglingNarrativeLeaf(", "function evalNarrativeLeaf(", "function narrativeLeafReached(",
    "function evalQuestLeaf(", "function evalFlagLeaf(", "function evalPlaneLeaf(",
    "export function evaluateConditionExpr(", "export function evaluateConditionExprWithTrace(",
    "export function formatConditionTrace(", "export function evaluateGraphCondition(",
    "export function evaluateAllGraphConditions(", "export function evaluatePreconditionsWithTrace(",
]), "TypeScript condition evaluator function architecture/order drift")
condition_evaluator_methods = re.findall(r"^static func ([A-Za-z_][A-Za-z0-9_]*)\(", gd_condition_evaluator, flags=re.MULTILINE)
require(condition_evaluator_methods == [
    "resolve_narrative_graph_ref", "_is_condition_leaf", "_is_quest_leaf", "_is_scenario_leaf",
    "_is_scenario_line_leaf", "_is_plane_leaf", "_is_narrative_leaf", "_is_all_node", "_is_any_node",
    "_is_not_node", "_apply_resolved_flag_condition_value", "_eval_scenario_leaf",
    "_eval_scenario_line_leaf", "_dev_report_dangling_narrative_leaf", "_eval_narrative_leaf",
    "_narrative_leaf_reached", "_eval_quest_leaf", "_eval_flag_leaf", "_eval_plane_leaf", "evaluate",
    "evaluate_with_trace", "format_trace", "evaluate_graph_condition", "evaluate_all_graph_conditions",
    "evaluate_preconditions_with_trace", "_strict_equal",
], f"Godot condition evaluator module-function surface/order drift: {condition_evaluator_methods}")
require("func evaluate_list(" not in gd_condition_evaluator and "RuntimeConditionEvaluator.new()" not in read("godot_port/scripts/bootstrap.gd") + read("godot_port/scripts/systems/graph_dialogue_manager.gd") + read("godot_port/scripts/systems/document_reveal_manager.gd"),
        "Godot condition evaluator regressed from source module functions to an invented stateful service/list API")
require(ordered_tokens(ts_condition_bridge, [
    "export function evaluateConditionExprList(", "if (!conditions || conditions.length === 0) return true",
    "for (const c of conditions)", "if (!evaluateConditionExpr(c as ConditionExpr, ctx)) return false", "return true",
]), "TypeScript condition list bridge architecture drift")
require(ordered_tokens(gd_condition_bridge, [
    "static func evaluate_condition_expr_list(", "if conditions == null", "if not conditions is Array",
    "for condition: Variant in conditions", "if not RuntimeConditionEvaluatorScript.evaluate(condition, context)", "return true",
]), "Godot condition list bridge loop/short-circuit architecture drift")
require("evaluate_list" not in gd_condition_bridge and ".new()" not in gd_condition_bridge,
        "Godot condition bridge delegates to an invented evaluator-list instance instead of owning source list AND")

condition_bridge_consumers = [
    "godot_port/scripts/runtime/flag_store.gd",
    "godot_port/scripts/runtime/depth_floor_zones.gd",
    "godot_port/scripts/systems/archive_manager.gd",
    "godot_port/scripts/systems/encounter_manager.gd",
    "godot_port/scripts/systems/interaction_system.gd",
    "godot_port/scripts/systems/inventory_manager.gd",
    "godot_port/scripts/systems/narrative_state_manager.gd",
    "godot_port/scripts/systems/quest_manager.gd",
    "godot_port/scripts/systems/zone_system.gd",
    "godot_port/scripts/ui/map_ui.gd",
]
for path in condition_bridge_consumers:
    require("RuntimeConditionEvalBridge" in read(path), f"condition consumer bypasses the source bridge topology: {path}")
require("RuntimeConditionEvalBridge.evaluate_condition_expr_list(conditions, context)" in read("godot_port/scripts/systems/encounter_manager.gd"),
        "Godot EncounterManager bypasses conditionEvalBridge")
require(all(token in gd_map_ui for token in [
    "var flag_store: RuntimeFlagStore", "var _condition_context_factory", "func set_condition_eval_context_factory(",
    "RuntimeConditionEvalBridge.evaluate_condition_expr_list(conditions, context)", "flag_store.check_conditions(conditions)",
]), "Godot MapUI flattens source FlagStore/ConditionEvalContext ownership into a callback")
require("set_condition_evaluator" not in gd_map_ui and "evaluate_conditions" not in gd_map_ui,
        "Godot MapUI retains a target-only condition callback API")
require(all(token in gd_depth_floor_zones for token in [
    "flag_store: RuntimeFlagStore", "condition_context: Variant = null",
    "RuntimeConditionEvalBridge.evaluate_condition_expr_list(zone.conditions, condition_context)",
    "flag_store.check_conditions(zone.conditions)",
]), "Godot depthFloorZones flattens the source FlagStore/context dependency pair")

require(ordered_tokens(ts_graph_dialogue_manager, [
    "private static readonly MAX_DRAIN_STEPS_PER_RUN", "private eventBus", "private flagStore",
    "private actionExecutor", "private assetManager", "private sceneManager", "private rulesManager",
    "private questManager", "private inventoryManager", "private scenarioState", "private strings",
    "private resolveDisplay", "private conditionCtxFactory", "private graph", "private graphSourceId",
    "private currentNodeId", "private active", "private npcName", "private npcId", "private dimBackground",
    "private ownerType", "private ownerId", "private opChain", "private choicePhase",
    "private awaitingLineDismiss", "private lineBeatIndex", "private drainDepth", "private opDrainGeneration",
    "private deferredGraphQueue", "private chainRunnerActive", "private chainContinuationPending",
    "private lastGraphEndWasContinuing", "private lastPreconditionDebug", "private lastSwitchDebug",
    "private narrativeRouteNodeIds", "constructor(", "setConditionEvalContextFactory(",
    "getNarrativeEvalDebug(", "private conditionCtx(", "private pushNarrativeRouteStep(",
    "private runExclusive(", "private runUserOp(", "init(ctx", "setResolveDisplay(", "private r(",
    "update(_dt", "serialize()", "deserialize(", "get isActive", "get hasPendingChainContinuation",
    "getDebugInteractionState(", "getPlayerDialogue(", "getDialogueViewDebug(", "getContextNpcId(",
    "destroy()", "async startDialogueGraph(", "async advance(", "private async advanceCore(",
    "async chooseOption(", "async debugAdvanceUntilBlocking(", "async debugChooseOption(",
    "endDialogue(", "private resetSessionFields(", "private async runDeferredChainContinuation(",
    "private async drainUntilBlocking(", "private showChoiceOptionsFromPrompt(",
    "private inventoryCoinsForChoice(", "private emitChoicesForNode(", "private buildChoicesForNode(",
    "private buildChoiceDisableHint(", "private normalizeChoiceText(", "private evalSwitch(",
    "private evalOwnerState(", "private evalContextState(", "private lineBeatsFor(",
    "private linePayloadToDialogueLine(", "private speakerEntityOf(", "private resolvePortrait(",
    "private playerPortraitSlugProvider", "setPlayerPortraitSlugProvider(", "private speakerNpcId(",
    "private resolveSpeaker(",
]), "TypeScript GraphDialogueManager field/method architecture drift")
graph_dialogue_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_graph_dialogue_manager, flags=re.MULTILINE)
graph_dialogue_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_graph_dialogue_manager, flags=re.MULTILINE)
require(graph_dialogue_fields == [
    "event_bus", "flag_store", "action_executor", "asset_manager", "scene_manager", "rules_manager",
    "quest_manager", "inventory_manager", "scenario_state", "strings", "resolve_display",
    "condition_ctx_factory", "graph", "graph_source_id", "current_node_id", "active", "npc_name",
    "npc_id", "dim_background", "owner_type", "owner_id", "op_chain", "choice_phase",
    "awaiting_line_dismiss", "line_beat_index", "drain_depth", "op_drain_generation",
    "deferred_graph_queue", "chain_runner_active", "chain_continuation_pending",
    "last_graph_end_was_continuing", "last_precondition_debug", "last_switch_debug",
    "narrative_route_node_ids", "player_portrait_slug_provider",
], f"Godot GraphDialogueManager field architecture/order drift: {graph_dialogue_fields}")
require(graph_dialogue_methods == [
    "_init", "set_condition_eval_context_factory", "get_narrative_eval_debug", "_condition_ctx",
    "_push_narrative_route_step", "_run_exclusive", "_run_user_op", "init", "set_resolve_display", "_r",
    "update", "serialize", "deserialize", "is_active", "has_pending_chain_continuation",
    "get_debug_interaction_state", "get_player_dialogue", "get_dialogue_view_debug", "get_context_npc_id",
    "destroy", "start_dialogue_graph", "advance", "_advance_core", "choose_option",
    "debug_advance_until_blocking", "debug_choose_option", "end_dialogue", "_reset_session_fields",
    "_run_deferred_chain_continuation", "_drain_until_blocking", "_show_choice_options_from_prompt",
    "_inventory_coins_for_choice", "_emit_choices_for_node", "_build_choices_for_node",
    "_build_choice_disable_hint", "_normalize_choice_text", "_eval_switch", "_eval_owner_state",
    "_eval_context_state", "_line_beats_for", "_line_payload_to_dialogue_line", "_speaker_entity_of",
    "_resolve_portrait", "set_player_portrait_slug_provider", "_speaker_npc_id", "_resolve_speaker",
], f"Godot GraphDialogueManager method architecture/order drift: {graph_dialogue_methods}")
gd_graph_context = gd_function(gd_graph_dialogue_manager, "_condition_ctx")
require(ordered_tokens(gd_graph_context, [
    "condition_ctx_factory.call()", "var current_owner: Variant = null", "owner_type.strip_edges()",
    "owner_id.strip_edges()", 'current_owner = {"ownerType":', "if injected is Dictionary:",
    "if current_owner == null:", "return injected", "injected.duplicate(false)",
    "with_owner.currentOwner = current_owner", '"flagStore": flag_store', '"questManager": quest_manager',
    '"scenarioState": scenario_state', '"resolveConditionLiteral": func', '"currentOwner": current_owner',
]), "Godot GraphDialogueManager conditionCtx spread-copy/owner override topology drift")
graph_run_exclusive = gd_function(gd_graph_dialogue_manager, "_run_exclusive")
graph_run_user = gd_function(gd_graph_dialogue_manager, "_run_user_op")
require(ordered_tokens(graph_run_exclusive, [
    "var tail := op_chain", "var generation_at_schedule := op_drain_generation", "await tail.then(func",
    "if generation_at_schedule != op_drain_generation:", "await callback.call()",
    '"GraphDialogueManager: op failed"',
]), "Godot GraphDialogueManager Promise tail/generation serialization drift")
require(ordered_tokens(graph_run_user, [
    "if drain_depth > 0:", "await RuntimeMicrotaskQueue.yield_turn()", "await callback.call()",
    "await _run_exclusive(callback)",
]), "Godot GraphDialogueManager drain-reentrant user-op scheduling drift")
graph_deserialize = gd_function(gd_graph_dialogue_manager, "deserialize")
graph_destroy = gd_function(gd_graph_dialogue_manager, "destroy")
require(ordered_tokens(graph_deserialize, [
    "deferred_graph_queue.clear()", "chain_continuation_pending = false",
    "last_graph_end_was_continuing = false", "_reset_session_fields()",
]) and "end_dialogue" not in graph_deserialize and "chain_runner_active" not in graph_deserialize,
        "Godot GraphDialogueManager silent transient deserialize/reset ownership drift")
require(ordered_tokens(graph_destroy, [
    "deferred_graph_queue.clear()", "chain_continuation_pending = false",
    "last_graph_end_was_continuing = false", "if active:", "end_dialogue()", "else:",
    "op_drain_generation += 1", "op_chain = RuntimeAsyncTail.new()", "strings = null",
]), "Godot GraphDialogueManager active/inflight destroy generation topology drift")
gd_graph_start = gd_function(gd_graph_dialogue_manager, "start_dialogue_graph")
require(ordered_tokens(gd_graph_start, [
    "var graph_id :=", "strip_edges()", "if graph_id.is_empty():", "if drain_depth > 0 and active:",
    "deferred_graph_queue.push_back({", '"graphId": graph_id', '"entry":', '"npcName":', '"npcId":',
    '"ownerType":', '"ownerId":', '"preferGraphMetaTitle":', '"dimBackground":', "return",
    "await _run_exclusive(func", "if active:", "已有对话进行中", "var generation_at_start := op_drain_generation",
    "dialogue_graph_json_url(graph_id)", "asset_manager.load_json(path)",
    "await RuntimeMicrotaskQueue.yield_turn()", "if not raw is Dictionary:", "无法加载",
    "if generation_at_start != op_drain_generation:", 'raw.get("nodes") is Dictionary',
    'raw.get("entry") is String', "缺少 entry 或 nodes", "RuntimeDevErrorOverlay.report_dev_error",
    "raw_id", "与路径 graphId", "last_switch_debug = null", "var precondition_context := _condition_ctx()",
    "RuntimeConditionEvaluator.evaluate_preconditions_with_trace", "last_precondition_debug = {",
    "preconditions 不满足", "graph = raw", "graph_source_id = graph_id", "meta_title",
    "npc_name =", "npc_id =", "owner_type =", 'owner_type = "npc"', "owner_id =", "dim_background =",
    "current_node_id =", "narrative_route_node_ids.assign", "active = true", "choice_phase = null",
    "awaiting_line_dismiss = false", "line_beat_index = 0", 'event_bus.emit("dialogue:start"',
    "await _drain_until_blocking()",
]) and "duplicate(" not in gd_graph_start and "-> bool" not in gd_graph_start,
        "Godot GraphDialogueManager start Promise<void>/precondition/source-reference/order drift")
graph_advance = gd_function(gd_graph_dialogue_manager, "advance")
graph_advance_core = gd_function(gd_graph_dialogue_manager, "_advance_core")
graph_choose = gd_function(gd_graph_dialogue_manager, "choose_option")
require(ordered_tokens(graph_advance, [
    "await _run_user_op(func", "if not active", "not awaiting_line_dismiss",
    'choice_phase.stage == "prompt"', "await _advance_core()",
]), "Godot GraphDialogueManager advance acceptance gate/serialization drift")
require(ordered_tokens(graph_advance_core, [
    'choice_phase.stage == "prompt"', "_show_choice_options_from_prompt()", "if awaiting_line_dismiss:",
    "awaiting_line_dismiss = false", "_line_beats_for", "line_beat_index += 1",
    'event_bus.emit("dialogue:line"', "awaiting_line_dismiss = true", 'event_bus.emit("dialogue:willEnd"',
    "line_beat_index = 0", 'next_after_line.get("type") == "runActions"',
    'event_bus.emit("dialogue:prepareBeat"', "current_node_id =", "_push_narrative_route_step",
    "await _drain_until_blocking()", 'current.get("type") == "end"', "end_dialogue()",
]), "Godot GraphDialogueManager line-beat/prepareBeat advance order drift")
require(ordered_tokens(graph_choose, [
    "await _run_user_op(func", 'choice_phase.stage != "options"', 'node.get("type") != "choice"',
    "_build_choices_for_node(node)", 'built_choice.get("enabled") != true', 'option.get("costCoins")',
    "inventory_manager.remove_coins", 'event_bus.emit("dialogue:choiceSelected:log"',
    "choice_phase = null", "current_node_id =", "_push_narrative_route_step", "await _advance_core()",
]) and "-> bool" not in graph_choose,
        "Godot GraphDialogueManager chooseOption Promise<void>/cost/advanceCore drift")
graph_end = gd_function(gd_graph_dialogue_manager, "end_dialogue")
graph_reset = gd_function(gd_graph_dialogue_manager, "_reset_session_fields")
graph_chain = gd_function(gd_graph_dialogue_manager, "_run_deferred_chain_continuation")
require(ordered_tokens(graph_end, [
    "if not active:", "_reset_session_fields()", "var will_continue := not deferred_graph_queue.is_empty()",
    "last_graph_end_was_continuing = will_continue", 'event_bus.emit("dialogue:end"',
    '"source": "graph"', '"willContinue": will_continue', "if not will_continue:",
    "if chain_runner_active:", "chain_continuation_pending = true", "_run_deferred_chain_continuation()",
]), "Godot GraphDialogueManager dialogue:end continuation payload/runner gate drift")
require(ordered_tokens(graph_reset, [
    "active = false", "graph = null", 'graph_source_id = ""', 'current_node_id = ""', 'npc_name = ""',
    'npc_id = ""', 'owner_type = ""', 'owner_id = ""', "dim_background = false", "choice_phase = null",
    "last_precondition_debug = null", "last_switch_debug = null", "narrative_route_node_ids.clear()",
    "awaiting_line_dismiss = false", "line_beat_index = 0", "op_drain_generation += 1",
    "op_chain = RuntimeAsyncTail.new()",
]), "Godot GraphDialogueManager session reset/op-generation order drift")
require(ordered_tokens(graph_chain, [
    "chain_runner_active = true", "while not active and not deferred_graph_queue.is_empty():",
    "deferred_graph_queue.pop_front()", "await start_dialogue_graph(item)",
    "chain_runner_active = false", "chain_continuation_pending = false",
    "if not active and last_graph_end_was_continuing:", "last_graph_end_was_continuing = false",
    'event_bus.emit("dialogue:end", {"source": "graph", "willContinue": false})',
]), "Godot GraphDialogueManager deferred chain exactly-once final-end drift")
graph_drain = gd_function(gd_graph_dialogue_manager, "_drain_until_blocking")
require(ordered_tokens(graph_drain, [
    "drain_depth += 1", "var steps := 0", "while active and graph is Dictionary:", "steps += 1",
    "steps > MAX_DRAIN_STEPS_PER_RUN", "push_error(", "end_dialogue()", "graph.nodes.get(current_node_id)",
    "缺失节点", 'node.get("type") == "switch"', "_eval_switch", 'node.get("type") == "ownerState"',
    "_eval_owner_state", 'node.get("type") == "contextState"', "_eval_context_state",
    'node.get("type") == "runActions"', 'event_bus.emit("dialogue:hidePanel"',
    "await action_executor.execute_await(action)", "runActions 执行失败", "current_node_id =",
    'node.get("type") == "line"', "_line_beats_for", "line 节点无可用台词",
    'event_bus.emit("dialogue:line"', "awaiting_line_dismiss = true", 'event_bus.emit("dialogue:willEnd"',
    'node.get("type") == "choice"', 'node.get("promptLine") is Dictionary',
    'event_bus.emit("dialogue:prepareBeat"', "_emit_choices_for_node(node)", 'node.get("type") == "end"',
    "未知节点类型", "drain_depth -= 1",
]), "Godot GraphDialogueManager seven-node serial drain/failure/finally topology drift")
graph_emit_choices = gd_function(gd_graph_dialogue_manager, "_emit_choices_for_node")
graph_build_choices = gd_function(gd_graph_dialogue_manager, "_build_choices_for_node")
require(ordered_tokens(graph_emit_choices, [
    "_build_choices_for_node(node)", "var has_enabled := false", "if choices.is_empty() or not has_enabled:",
    "push_error(", "end_dialogue()", 'event_bus.emit("dialogue:choices", choices)',
]), "Godot GraphDialogueManager all-disabled choice soft-lock guard drift")
require(ordered_tokens(graph_build_choices, [
    "var context := _condition_ctx()", 'option.get("requireFlag"',
    'option.has("requireCondition") and option.get("requireCondition") != null',
    "RuntimeConditionEvaluator.evaluate(option.requireCondition, context)", "flag_store.check_conditions",
    'option.get("costCoins")', "_inventory_coins_for_choice()", "var enabled := require_ok and cost_ok",
    'option.get("disabledClickHint") is String', "_build_choice_disable_hint({", '"reqExprOk":',
    '"ruleHintId":', '"text": _r(', '"tags": []', '"enabled": enabled',
]), "Godot GraphDialogueManager choice condition/cost/hint projection drift")
graph_switch = gd_function(gd_graph_dialogue_manager, "_eval_switch")
graph_owner = gd_function(gd_graph_dialogue_manager, "_eval_owner_state")
graph_context_state = gd_function(gd_graph_dialogue_manager, "_eval_context_state")
require(ordered_tokens(graph_switch, [
    "var context := _condition_ctx()", 'case.has("condition") and case.get("condition") != null',
    "RuntimeConditionEvaluator.evaluate_with_trace(case.condition, context)", "var conditions: Variant",
    'expression: Variant = conditions[0] if conditions.size() == 1',
    "RuntimeConditionEvaluator.format_trace", "if matched:", "break", "last_switch_debug = {",
]), "Godot GraphDialogueManager switch nullish/trace/first-match topology drift")
require(ordered_tokens(graph_owner, [
    'node.get("missingWrapperNext"', "owner_type.strip_edges()", "owner_id.strip_edges()",
    "RuntimeConditionEvaluator.resolve_narrative_graph_ref", "has no dialogue owner context",
    "narrative.get_graph(wrapper_graph_id)", "references missing wrapperGraphId", 'wrapper_graph.get("ownerType"',
    "belongs to", "narrative.get_active_state(wrapper_graph_id)", "cannot read active state",
    "narrative.get_graph_ids_by_owner", "owner_graph_ids.size() > 1", "is ambiguous",
    "narrative.get_primary_active_state_by_owner", "cannot resolve wrapper", 'case.get("state") == active_state',
]), "Godot GraphDialogueManager ownerState wrapper/ambiguity/fallback drift")
require(ordered_tokens(graph_context_state, [
    "var context := _condition_ctx()", "RuntimeConditionEvaluator.resolve_narrative_graph_ref",
    "missing graphId", "narrative.get_active_state(graph_id)", "cannot read active state",
    'case.get("state") == active_state',
]), "Godot GraphDialogueManager contextState relative-token/fallback drift")
graph_beats = gd_function(gd_graph_dialogue_manager, "_line_beats_for")
graph_line = gd_function(gd_graph_dialogue_manager, "_line_payload_to_dialogue_line")
graph_portrait = gd_function(gd_graph_dialogue_manager, "_resolve_portrait")
require(ordered_tokens(graph_beats, [
    'node.get("lines")', "if lines is Array and not lines.is_empty():", 'if not node.has("portrait"):',
    "return lines", "if payload is Dictionary and not payload.has(\"portrait\"):",
    "payload.duplicate(false)", "with_portrait.portrait = node.portrait", "output.push_back(payload)",
]), "Godot GraphDialogueManager multi-beat node-portrait shallow-default drift")
require(ordered_tokens(graph_line, [
    "_resolve_speaker(speaker)", 'payload.get("textKey")', "strings.get_text(\"dialogue\", key)",
    "resolved != key", '"speaker": resolved_speaker', '"text": _r(text)', '"tags": []',
    "_resolve_portrait(payload)", "_speaker_entity_of(speaker)", "if dim_background:", "line.dim = true",
]), "Godot GraphDialogueManager full dialogue:line payload/text fallback drift")
require(ordered_tokens(graph_portrait, [
    'payload.get("portrait")', 'reference.get("emotion"', 'reference.get("slug") is String',
    "return reference", 'speaker.get("kind") == "player"', "player_portrait_slug_provider.call()",
    'return {"slug": player_slug', "_speaker_npc_id(speaker)", "scene_manager.get_npc_by_id(id)",
    "npc.get_current_portrait_slug()", 'return {"slug": npc_slug',
]), "Godot GraphDialogueManager explicit/follow-speaker portrait ownership drift")
for forbidden_graph_api in [
    "MAX_DRAIN_STEPS :=", "_chain_generation", "_destroyed", "var _condition_context_factory",
    "var _resolve_display", "var _player_portrait_slug", "func _line_payload(", "func _build_choices(",
    "func _show_choice_options(", "func _continue_deferred_chain(", "graph = raw.duplicate",
    "execute_batch_await(node", "func start_dialogue_graph(request: Dictionary) -> bool",
    "func choose_option(index: int) -> bool",
]:
    require(forbidden_graph_api not in gd_graph_dialogue_manager,
            f"Godot GraphDialogueManager retains flattened/invented target-only API/state: {forbidden_graph_api}")
require("var started: Variant = await graph_dialogue_manager.start_dialogue_graph" not in interaction
        and interaction.count("await graph_dialogue_manager.start_dialogue_graph(request)") == 2,
        "Godot InteractionCoordinator still treats source GraphDialogueManager Promise<void> as bool")

require(ordered_tokens(ts_document_reveal_manager, [
    "private assetManager", "private eventBus", "private flagStore", "private questManager",
    "private scenarioState", "private defs", "private revealed", "private revealing", "private blend",
    "private resolveConditionLiteral", "private conditionCtxFactory", "constructor(",
    "setBlendExecutor(", "setResolveConditionLiteral(", "setConditionEvalContextFactory(",
    "async loadDefinitions(", "init(_ctx", "update(_dt", "destroy()", "private ctx(",
    "private overlayIdFor(", "getDocumentPhase(", "getDisplayImage(", "isRevealed(",
    "async checkAndReveal(", "debugSnapshot(", "serialize()", "deserialize(",
]), "TypeScript DocumentRevealManager field/method architecture drift")
document_reveal_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_document_reveal_manager, flags=re.MULTILINE)
document_reveal_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_document_reveal_manager, flags=re.MULTILINE)
require(document_reveal_fields == [
    "asset_manager", "event_bus", "flag_store", "quest_manager", "scenario_state", "defs", "revealed",
    "revealing", "blend", "resolve_condition_literal", "condition_ctx_factory",
], f"Godot DocumentRevealManager field architecture/order drift: {document_reveal_fields}")
require(document_reveal_methods == [
    "_init", "set_blend_executor", "set_resolve_condition_literal", "set_condition_eval_context_factory",
    "load_definitions", "init", "update", "destroy", "_ctx", "_overlay_id_for",
    "get_document_phase", "get_display_image", "is_revealed", "check_and_reveal",
    "debug_snapshot", "serialize", "deserialize",
], f"Godot DocumentRevealManager method architecture/order drift: {document_reveal_methods}")
for forbidden_document_reveal_api in [
    "func load_definitions_from_data(", "func definition_count(", "func debug_snapshot_fragment(",
    "var _defs", "var _revealed", "var _revealing", "var _blend", "func _condition_context(",
    "func _safe_id(", "func load_definitions() -> bool", "float(definition.get(",
]:
    require(forbidden_document_reveal_api not in gd_document_reveal_manager,
            f"Godot DocumentRevealManager retains flattened/invented target-only API/state: {forbidden_document_reveal_api}")
document_load = gd_function(gd_document_reveal_manager, "load_definitions")
require(ordered_tokens(document_load, [
    "defs.clear()", "asset_manager.load_json(DOCUMENT_REVEALS_URL)",
    "await RuntimeMicrotaskQueueScript.yield_turn()", "asset_manager.get_last_error()",
    "DocumentRevealManager: 无法加载 document_reveals.json", "if not list is Array:",
    'definition.get("id") is String', "definition.id.strip_edges()", "defs[id] = definition",
]), "Godot DocumentRevealManager loadDefinitions clear/await/error/raw-reference topology drift")
require("await document_reveal_manager.load_definitions()" in bootstrap
        and "if not document_reveal_manager.load_definitions()" not in bootstrap,
        "Godot Game changes DocumentRevealManager loadDefinitions Promise<void> contract")
document_destroy = gd_function(gd_document_reveal_manager, "destroy")
require(ordered_tokens(document_destroy, [
    "defs.clear()", "revealed.clear()", "revealing.clear()", "blend = Callable()",
    "resolve_condition_literal = Callable()", "condition_ctx_factory = Callable()",
]), "Godot DocumentRevealManager destroy ownership/callback release drift")
document_ctx = gd_function(gd_document_reveal_manager, "_ctx")
require(ordered_tokens(document_ctx, [
    "condition_ctx_factory.is_valid()", "condition_ctx_factory.call()", "if injected is Dictionary:",
    "return injected", '"flagStore": flag_store', '"questManager": quest_manager',
    '"scenarioState": scenario_state', "resolve_condition_literal.is_valid()",
    "base.resolveConditionLiteral = resolve_condition_literal", "return base",
]), "Godot DocumentRevealManager injected/fallback condition context ownership drift")
document_overlay = gd_function(gd_document_reveal_manager, "_overlay_id_for")
require(ordered_tokens(document_overlay, [
    'definition.get("overlayId")', "raw_overlay_id.strip_edges()", "return overlay_id",
    'definition.get("id", "")', 'regex.compile("[^a-zA-Z0-9_-]")',
    'return "docReveal_%s" % regex.sub(id, "_", true)',
]), "Godot DocumentRevealManager overlay handle/default-id semantics drift")
document_phase = gd_function(gd_document_reveal_manager, "get_document_phase")
require(ordered_tokens(document_phase, [
    "document_id.strip_edges()", "id.is_empty() or not defs.has(id)", 'return "hidden"',
    "revealed.has(id)", 'return "revealed"', "revealing.has(id)", 'return "revealing"',
    'return "blurred"',
]), "Godot DocumentRevealManager phase precedence drift")
document_reveal = gd_function(gd_document_reveal_manager, "check_and_reveal")
require(ordered_tokens(document_reveal, [
    "document_id.strip_edges()", "defs.get(id)", "DocumentRevealManager: 未知 documentId",
    "revealed.has(id)", "revealing.has(id)",
    'RuntimeConditionEvaluator.evaluate(definition.get("revealCondition"), _ctx())',
    "var blend_fn := blend", "DocumentRevealManager: blend 未注入", "_overlay_id_for(definition)",
    'definition.get("xPercent")', "if x == null:", "x = 50", 'definition.get("yPercent")',
    "if y == null:", "y = 50", 'definition.get("widthPercent")', "if width == null:",
    "width = 40", 'definition.get("animation")', 'animation.get("durationMs")',
    "if duration == null:", "duration = 2000", 'animation.get("delayMs")', "if delay == null:",
    "delay = 0", "revealing[id] = true", 'event_bus.emit("document:revealed", {"documentId": id})',
    "await blend_fn.call(", 'definition.get("blurredImagePath")', 'definition.get("clearImagePath")',
    "await RuntimeMicrotaskQueueScript.yield_turn()", "blend_result is bool and blend_result == false",
    "DocumentRevealManager: reveal %s failed", "revealed[id] = true", 'definition.get("revealedFlag")',
    "revealed_flag.strip_edges()", "flag_store.set_value(flag_id, true)", "revealing.erase(id)",
]), "Godot DocumentRevealManager condition/reentry/event/blend/commit/finally order drift")
require("str(definition.get(\"blurredImagePath\"" not in document_reveal
        and "str(definition.get(\"clearImagePath\"" not in document_reveal,
        "Godot DocumentRevealManager coerces source image refs instead of forwarding them")
document_debug = gd_function(gd_document_reveal_manager, "debug_snapshot")
document_serialize = gd_function(gd_document_reveal_manager, "serialize")
document_deserialize = gd_function(gd_document_reveal_manager, "deserialize")
require(ordered_tokens(document_debug, [
    "for id: String in defs:", "phase_by_def_id[id] = get_document_phase(id)",
    '"revealedInSave": revealed.keys()', '"revealingTransient": revealing.keys()',
    '"phaseByDefId": phase_by_def_id',
]), "Godot DocumentRevealManager debug snapshot phase/save/transient projection drift")
require('return {"revealed": revealed.keys()}' in document_serialize,
        "Godot DocumentRevealManager serialize changes source Set insertion-order shape")
require(ordered_tokens(document_deserialize, [
    "revealed.clear()", "revealing.clear()", 'data.get("revealed")', "if not raw is Array:",
    "for value: Variant in raw:", "if value is String:", "value.strip_edges()",
    "if not id.is_empty():", "revealed[id] = true",
]), "Godot DocumentRevealManager deserialize clear/filter/trim/Set topology drift")

require(ordered_tokens(ts_rule_offer_registry, [
    "private byZone", "register(", "unregister(", "clear(", "getAggregatedSlots(",
]), "TypeScript RuleOfferRegistry field/method architecture drift")
require(ordered_tokens(gd_rule_offer_registry, [
    "var _by_zone", "func register(", "func unregister(", "func clear(",
    "func get_aggregated_slots(",
]), "Godot RuleOfferRegistry field/method architecture/order drift")
require("func destroy(" not in gd_rule_offer_registry, "Godot RuleOfferRegistry exposes a non-source lifecycle API")
require("_by_zone[zone_id] = copy" in gd_rule_offer_registry, "Godot RuleOfferRegistry no longer preserves source Map replacement semantics")
require("result.append_array(slots)" in gd_rule_offer_registry, "Godot RuleOfferRegistry no longer preserves source Map aggregation order")

require(ordered_tokens(ts_game_state_controller, [
    "private _currentState", "private _previousState", "private overlayReturnStack",
    "private panels", "private escapeFallback", "private unsubKeyDown", "constructor(",
    "get currentState", "get previousState", "getDebugState(", "setState(",
    "restorePreviousState(", "registerPanel(", "setEscapeFallback(",
    "triggerEscapeFromTouch(", "closeAllPanels(", "closePanel(", "togglePanel(",
    "handleKeyDown(", "handleEscape(", "destroy(",
]), "TypeScript GameStateController field/method architecture drift")
require(ordered_tokens(gd_game_state_controller, [
    "var _current_state", "var _previous_state", "var _overlay_return_stack",
    "var _panels", "var _escape_fallback", "var _unsubscribe_key_down",
    "var _event_bus", "var current_state", "var previous_state", "func _init(",
    "func get_debug_state(", "func set_state(", "func restore_previous_state(",
    "func register_panel(", "func set_escape_fallback(",
    "func trigger_escape_from_touch(", "func close_all_panels(",
    "func close_panel(", "func toggle_panel(", "func _handle_key_down(",
    "func _handle_escape(", "func destroy(",
]), "Godot GameStateController field/method architecture/order drift")
for forbidden in ["func bind_input_manager(", "func overlay_depth(", "func debug_snapshot(", "func handle_key_down("]:
    require(forbidden not in gd_game_state_controller, f"Godot GameStateController exposes a non-source API: {forbidden}")
require("func _init(input_manager: Variant, event_bus: RuntimeEventBus = null) -> void:" in gd_game_state_controller, "Godot GameStateController constructor dependency contract drift")
for source_void_method in ["set_state", "register_panel"]:
    require(re.search(rf"func {source_void_method}\([\s\S]*?\) -> void:", gd_game_state_controller) is not None, f"Godot GameStateController changes source-void contract: {source_void_method}")
require("GameStateController: invalid state" not in gd_game_state_controller, "Godot GameStateController invents runtime validation outside the typed source contract")
require('close_panel(name, {"silent": true})' in gd_game_state_controller, "Godot GameStateController closePanel options-object protocol drift")
require("state_controller.get_debug_state()" in bootstrap and "state_controller.debug_snapshot()" not in bootstrap, "Godot Game bootstrap bypasses GameStateController.getDebugState")

require(ordered_tokens(ts_strings_provider, [
    "private data", "private resolveDisplay", "load(", "setResolveDisplay(",
    "getRaw(", "get(",
]), "TypeScript StringsProvider field/method architecture drift")
require(ordered_tokens(gd_strings_provider, [
    "var _data", "var _resolve_display", "func load(", "func set_resolve_display(",
    "func get_raw(", "func get_text(",
]), "Godot StringsProvider field/method architecture/order drift")
for forbidden in ["func category_count(", "func leaf_count("]:
    require(forbidden not in gd_strings_provider, f"Godot StringsProvider exposes a non-source diagnostic API: {forbidden}")
require("func load(asset_manager: Variant) -> void:" in gd_strings_provider, "Godot StringsProvider changes source-void load contract")
require('push_warning("StringsProvider: strings.json not found, using fallback strings")' in gd_strings_provider, "Godot StringsProvider load failure semantics drift")
require("if not strings_provider.load" not in bootstrap and "strings_provider.load(asset_manager)" in bootstrap, "Godot Game treats source-void StringsProvider.load as a boolean")

require(ordered_tokens(ts_asset_manager, [
    "function createBucket", "function textBytes", "function jsonBytes",
    "function textureBytes", "function assertSafeTextureSize",
    "function bitmapBytes", "function audioBytes",
]), "TypeScript AssetManager module-helper architecture drift")
require(ordered_tokens(gd_asset_manager, [
    "static func _create_bucket", "static func _text_bytes", "static func _json_bytes",
    "static func _texture_bytes", "func _assert_safe_texture_size",
    "static func _bitmap_bytes", "static func _audio_bytes",
]), "Godot AssetManager module-helper architecture/order drift")
require(ordered_tokens(ts_asset_manager, [
    "private buckets", "private logicalClock", "private scopeRefs",
    "private disposed", "private readonly verboseStageLog",
]), "TypeScript AssetManager field architecture drift")
require(ordered_tokens(gd_asset_manager, [
    "var _buckets", "var _logical_clock", "var _scope_refs", "var _disposed",
    "var _verbose_stage_log", "var _locator", "var _last_error",
]), "Godot AssetManager field architecture/order drift")
require(ordered_tokens(ts_asset_manager, [
    "constructor(", "touch<", "getFromBucket<", "loadIntoBucket<", "evict(",
    "bucketBytes(", "disposeEntry(", "disposeValue(", "keyForRef(",
    "loadTexture(", "getTexture(", "loadJson<", "getJson<", "loadText(",
    "getText(", "loadBitmap(", "getBitmap(", "loadAudio(", "getAudio(",
    "loadFilter(", "getFilter(", "preloadManifest(", "loadRef(", "pinScope(",
    "pinLoadedRef(", "scopesForKey(", "releaseScope(", "getStats(",
    "clearCache(", "dispose(", "resolveSceneAssetPath(", "loadSceneData(",
    "dedupeRefs(",
]), "TypeScript AssetManager method architecture drift")
require(ordered_tokens(gd_asset_manager, [
    "func _init(", "func _touch(", "func _get_from_bucket(",
    "func _load_into_bucket(", "func _evict(", "func _bucket_bytes(",
    "func _dispose_entry(", "func _dispose_value(", "func _key_for_ref(",
    "func load_texture(", "func get_texture(", "func load_json(",
    "func get_json(", "func load_text(", "func get_text(",
    "func load_bitmap(", "func get_bitmap(", "func load_audio(",
    "func get_audio(", "func load_filter(", "func get_filter(",
    "func preload_manifest(", "func load_ref(", "func pin_scope(",
    "func _pin_loaded_ref(", "func _scopes_for_key(", "func release_scope(",
    "func get_stats(", "func clear_cache(", "func dispose(",
    "func resolve_scene_asset_path(", "func load_scene_data(",
    "func _dedupe_refs(",
]), "Godot AssetManager method architecture/order drift")
require("func _init(limits: Dictionary = {}, resource_locator: RuntimeResourceLocator = null) -> void:" in gd_asset_manager, "Godot AssetManager constructor no longer keeps source limits-first contract")
for forbidden in ["var locator", "var last_error", "func debug_snapshot(", "AssetManager is disposed"]:
    require(forbidden not in gd_asset_manager, f"Godot AssetManager exposes a non-source responsibility/API: {forbidden}")
asset_load_core = section(gd_asset_manager, "func _load_into_bucket", "func _evict")
require(ordered_tokens(asset_load_core, [
    "bucket.entries.get(key)", "bucket.stats.misses += 1", "loader.call()",
    "if value == null:", "if _disposed:", "_dispose_value(type, value)",
    "return value", "bucket.stats.loads += 1",
]), "Godot AssetManager cache/load/dispose sequencing drift")
require("bucket.entries.erase(entry.key)" in section(gd_asset_manager, "func _touch", "func _get_from_bucket") and "bucket.entries[entry.key] = entry" in section(gd_asset_manager, "func _touch", "func _get_from_bucket"), "Godot AssetManager touch no longer preserves source Map LRU order")
require("_dispose_entry(entry)" in section(gd_asset_manager, "func clear_cache", "func dispose"), "Godot AssetManager clearCache bypasses source resource disposal")
require("result.push_back(ref)" in section(gd_asset_manager, "func _dedupe_refs", "func get_last_error") and "ref.duplicate" not in section(gd_asset_manager, "func _dedupe_refs", "func get_last_error"), "Godot AssetManager changes source manifest-ref identity semantics")
require("stream.get_length()" in section(gd_asset_manager, "static func _audio_bytes", "func _init"), "Godot AssetManager audio cache size no longer mirrors decoded PCM estimate")
asset_locator_consumers = "\n".join(path.read_text(encoding="utf-8") for path in (PORT / "scripts").rglob("*.gd") if path != PORT / "scripts/runtime/asset_manager.gd")
require("asset_manager.locator" not in asset_locator_consumers and ".asset_manager.locator" not in asset_locator_consumers, "Godot domain modules use AssetManager as a project-path service locator")
require("var resource_locator" not in bootstrap and "RuntimeAssetManager.new()" in bootstrap, "Godot Game retains a source-absent ResourceLocator field/AssetManager constructor dependency")

require(ordered_tokens(ts_text_resolver, [
    "const TAG_STRING", "const TAG_FLAG", "const TAG_ITEM", "const TAG_NPC",
    "const TAG_PLAYER", "const TAG_QUEST", "const TAG_RULE", "const TAG_SCENE",
    "MAX_RESOLVE_DEPTH", "function applyVars(", "function formatFlagValue(",
    "function warnUnknownTag(", "function normalizeEmbeddedTagsSyntax(",
    "function splitSpeakerBodyAfterResolve(",
    "function applyDialogueColonSpeakerFromResolvedText(", "function resolveText(",
    "function expandGameTags(",
]), "TypeScript resolveText module architecture drift")
require(ordered_tokens(gd_text_resolver, [
    "const TAG_STRING", "const TAG_FLAG", "const TAG_ITEM", "const TAG_NPC",
    "const TAG_PLAYER", "const TAG_QUEST", "const TAG_RULE", "const TAG_SCENE",
    "const MAX_RESOLVE_DEPTH", "static func _apply_vars(",
    "static func _format_flag_value(", "static func _warn_unknown_tag(",
    "static func _normalize_embedded_tags_syntax(",
    "static func split_speaker_body_after_resolve(",
    "static func apply_dialogue_colon_speaker_from_resolved_text(",
    "static func resolve_text(", "static func expand_game_tags(",
]), "Godot resolveText module architecture/order drift")
for forbidden in ["resolve_content_image_url", "parse_rich_segments", "func apply_dialogue_colon_speaker("]:
    require(forbidden not in gd_text_resolver, f"Godot resolveText owns a non-source responsibility/API: {forbidden}")
require("RuntimeTextResolver.new" not in bootstrap + action_registry + cutscene_manager + read("godot_port/scripts/ui/runtime_text_panel.gd"), "Godot turns the file-level resolveText module into an instance")
require("var text_resolver" not in bootstrap, "Godot Game retains a non-source textResolver field")
require("RuntimeTextResolver.resolve_text" in bootstrap, "Godot Game does not call the file-level resolveText translation")
require("static func resolve_content_image_url(" in gd_rich_content and "static func parse_segments(" in gd_rich_content, "Godot RichContent responsibilities were not separated from resolveText")

require(ordered_tokens(ts_input_manager, [
    "private keysDown", "private keyJustPressed", "private gameKeyboardBlocked",
    "private mousePos", "private mouseDown", "private mouseJustClicked",
    "private touchMoveX", "private touchMoveY", "private touchRunHeld",
    "private onKeyDownBound", "private onKeyUpBound", "private onPointerMoveBound",
    "private onPointerDownBound", "private onPointerUpBound", "private onWindowBlurBound",
    "private onVisibilityChangeBound", "private keyDownSubscribers",
    "private anyInputSubscribers", "private pointerDownSubscribers", "constructor(",
    "onFocusLost(", "onKeyDown(", "onKeyUp(", "onPointerMove(",
    "onPointerDown(", "onPointerUp(", "isKeyDown(", "wasKeyJustPressed(",
    "isMouseDown(", "wasMouseJustClicked(", "getMousePos(", "endFrame(",
    "getMovementDirection(", "isRunning(", "injectKeyJustPressed(",
    "injectPointerDown(", "setTouchMoveAxes(", "setTouchRunHeld(",
    "setGameKeyboardBlocked(", "subscribeKeyDown(", "subscribeAnyInput(",
    "subscribePointerDown(", "destroy(",
]), "TypeScript InputManager field/method architecture drift")
require(ordered_tokens(gd_input_manager, [
    "var _keys_down", "var _key_just_pressed", "var _game_keyboard_blocked",
    "var _mouse_pos", "var _mouse_down", "var _mouse_just_clicked",
    "var _touch_move_x", "var _touch_move_y", "var _touch_run_held",
    "var _key_down_subscribers", "var _any_input_subscribers",
    "var _pointer_down_subscribers", "func _ready(", "func _input(",
    "func _notification(", "func _on_focus_lost(", "func _on_key_down(",
    "func _on_key_up(", "func _on_pointer_move(", "func _on_pointer_down(",
    "func _on_pointer_up(", "func is_key_down(", "func was_key_just_pressed(",
    "func is_mouse_down(", "func was_mouse_just_clicked(", "func get_mouse_pos(",
    "func end_frame(", "func get_movement_direction(", "func is_running(",
    "func inject_key_just_pressed(", "func inject_pointer_down(",
    "func set_touch_move_axes(", "func set_touch_run_held(",
    "func set_game_keyboard_blocked(", "func subscribe_key_down(",
    "func subscribe_any_input(", "func subscribe_pointer_down(", "func destroy(",
]), "Godot InputManager field/method architecture/order drift")
for forbidden in [
    "signal focus_lost", "_key_up_subscribers", "func subscribe_key_up(",
    "func subscriber_count(", "func debug_key_down(", "func debug_key_up(",
    "func debug_pointer_move(", "func debug_pointer_down(", "func debug_pointer_up(",
    "func on_focus_lost(", "func _process(",
]:
    require(forbidden not in gd_input_manager, f"Godot InputManager exposes a non-source responsibility/API: {forbidden}")
require("input_manager.end_frame()" in bootstrap, "Godot Game no longer owns the source InputManager.endFrame call")
require("_touch_move_x = x" in gd_input_manager and "clampi(x" not in gd_input_manager, "Godot InputManager invents runtime clamping outside the typed source contract")
gd_water_manager = read("godot_port/scripts/minigames/water_manager.gd")
require("func _input(event: InputEvent)" in gd_water_manager and all(token in gd_water_manager for token in ["bound_pull_space_key_down", "bound_pull_space_key_up", "bound_pull_window_blur"]), "Godot water minigame does not own its source three-listener raw-input bridge")
require("subscribe_key_up" not in gd_water_manager and "input_manager.focus_lost" not in gd_water_manager, "Godot water raw-input bridge expands InputManager instead of remaining system-local")

require(ordered_tokens(ts_flag_keys, [
    "currentDay:", "hotspotPickedUp:", "ruleUsed:", "archiveCharacter:",
]), "TypeScript FlagKeys module architecture drift")
require(ordered_tokens(gd_flag_keys, [
    "const CURRENT_DAY", "static func hotspot_picked_up(", "static func rule_used(",
    "static func archive_character(",
]), "Godot FlagKeys module architecture/order drift")
require("RuntimeFlagKeys.CURRENT_DAY" in gd_water_manager and "RuntimeFlagKeys.CURRENT_DAY" in read("godot_port/scripts/systems/day_manager.gd"), "Godot current-day flag consumers bypass FlagKeys")
require("RuntimeFlagKeys.hotspot_picked_up" in interaction, "Godot InteractionCoordinator bypasses FlagKeys.hotspotPickedUp")
require("RuntimeFlagKeys.rule_used" in gd_bridge, "Godot EventBridge bypasses FlagKeys.ruleUsed")
require("RuntimeFlagKeys.archive_character" in read("godot_port/scripts/systems/archive_manager.gd"), "Godot ArchiveManager bypasses FlagKeys.archiveCharacter")

require(ordered_tokens(ts_day_manager, [
    "private eventBus", "private flagStore", "private actionExecutor",
    "private _currentDay", "private delayedEvents", "private endDayTail",
    "constructor(", "init(", "update(", "get currentDay", "endDay(",
    "finishEndDayAfterDelayed(", "addDelayedEvent(", "processDelayedEvents(",
    "syncFlag(", "serialize(", "deserialize(", "destroy(",
]), "TypeScript DayManager field/method architecture drift")
require(ordered_tokens(gd_day_manager, [
    "var _event_bus", "var _flag_store", "var _action_executor",
    "var _current_day", "var _delayed_events", "var _end_day_tail", "func _init(",
    "func init(", "func update(", "func get_current_day(", "func end_day(",
    "func _finish_end_day_after_delayed(", "func add_delayed_event(",
    "func _process_delayed_events(", "func _sync_flag(", "func serialize(",
    "func deserialize(", "func destroy(",
]), "Godot DayManager field/method architecture/order drift")
for forbidden in [
    "signal end_day_progress", "_end_day_requests", "_next_request_token",
    "_completed_request_token", "_end_day_running", "_destroyed",
    "func wait_until_idle(", "func debug_snapshot_fragment(",
]:
    require(forbidden not in gd_day_manager, f"Godot DayManager exposes a non-source responsibility/API: {forbidden}")
require("RuntimeAsyncTail.new()" in gd_day_manager and "await _end_day_tail.then" in gd_day_manager, "Godot DayManager does not preserve the single Promise-tail architecture")
require('{"targetDay": target_day, "actions": actions}' in gd_day_manager, "Godot DayManager changes delayed-action reference semantics")

require(ordered_tokens(ts_dialogue_manager, [
    "private eventBus", "private scriptedRemaining", "private active",
    "private currentNpcName", "private nestedInGraph", "constructor(", "init(",
    "update(", "serialize(", "deserialize(", "startScriptedDialogue(",
    "advance(", "chooseOption(", "scheduleEnd(", "endDialogue(",
    "get isActive", "destroy(",
]), "TypeScript DialogueManager field/method architecture drift")
require(ordered_tokens(gd_dialogue_manager, [
    "var _event_bus", "var _scripted_remaining", "var _active",
    "var _current_npc_name", "var _nested_in_graph", "func _init(", "func init(",
    "func update(", "func serialize(", "func deserialize(",
    "func start_scripted_dialogue(", "func advance(", "func choose_option(",
    "func _schedule_end(", "func end_dialogue(", "func is_active(",
    "func destroy(",
]), "Godot DialogueManager field/method architecture/order drift")
for forbidden in [
    "signal scripted_finished", "func play_and_wait(", "return false", "return true",
]:
    require(forbidden not in gd_dialogue_manager, f"Godot DialogueManager exposes a non-source responsibility/API: {forbidden}")
require("var _scripted_remaining: Variant = null" in gd_dialogue_manager, "Godot DialogueManager cannot represent source null-vs-empty scripted queue state")
require("func start_scripted_dialogue(lines: Array, nested_in_graph: bool = false) -> void:" in gd_dialogue_manager, "Godot DialogueManager changes source-void start contract")
require("_scripted_remaining = lines.slice(1)" in gd_dialogue_manager, "Godot DialogueManager changes source shallow queue-copy semantics")
require("var payload := first.duplicate()" in gd_dialogue_manager, "Godot DialogueManager does not shallow-copy the first emitted line")
require('_event_bus.emit("dialogue:line", line)' in gd_dialogue_manager, "Godot DialogueManager changes subsequent-line reference semantics")

expected_commands = CONTRACT["runtimeCommandTypes"]
ts_command_union = section(ts_dev_runtime_commands, "export type RuntimeCommand =", "export type RuntimeCommandResult")
ts_command_types = re.findall(r"type:\s*'([^']+)'", ts_command_union)
gd_command_switch = section(dev_runtime_commands, "\tmatch type:", "static func normalize_runtime_command")
gd_command_types = re.findall(r'^\t\t"([A-Za-z][A-Za-z0-9]+)":', gd_command_switch, flags=re.MULTILINE)
runtime_command_contract = json.loads((PORT / "compatibility/runtime-command-contract.json").read_text(encoding="utf-8"))
require(ts_command_types == expected_commands, f"TypeScript RuntimeCommand union drift: {ts_command_types}")
require(gd_command_types == expected_commands, f"Godot RuntimeDevRuntimeCommands command set/order drift: {gd_command_types}")
require(set(runtime_command_contract.get("commands", {})) == set(expected_commands), "runtime-command-contract.json command set drift")
ts_dev_runtime_functions = re.findall(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\(", ts_dev_runtime_commands, flags=re.MULTILINE)
gd_dev_runtime_functions = re.findall(r"^static func ([A-Za-z_][A-Za-z0-9_]*)\(", dev_runtime_commands, flags=re.MULTILINE)
require(ts_dev_runtime_functions == [
    "applyDevRuntimeCommand", "normalizeRuntimeCommand", "ok", "requiredString",
    "optionalString", "coerceFlagValue", "coerceQuestStatus", "coerceScenarioLifecycle",
    "coerceScenarioOutcome", "coercePositiveInt", "coerceNonNegativeInt",
    "coerceFiniteNumber", "coercePositiveNumber", "coerceDurationMs",
    "coerceSaveSlot", "coerceBool",
], f"TypeScript devRuntimeCommands function architecture drift: {ts_dev_runtime_functions}")
require(gd_dev_runtime_functions == [
    "apply_dev_runtime_command", "normalize_runtime_command", "_ok", "_required_string",
    "_optional_string", "_coerce_flag_value", "_coerce_quest_status",
    "_coerce_scenario_lifecycle", "_coerce_scenario_outcome", "_coerce_positive_int",
    "_coerce_non_negative_int", "_coerce_finite_number", "_coerce_positive_number",
    "_coerce_duration_ms", "_coerce_save_slot", "_coerce_bool",
], f"Godot devRuntimeCommands function architecture/order drift: {gd_dev_runtime_functions}")
require(not re.search(r"^var ", dev_runtime_commands, flags=re.MULTILINE), "Godot devRuntimeCommands invents owned state for a TypeScript file module")
for forbidden_dev_runtime_member in ["func _init(", "func apply(", "_ok_capture", "func _capture(", "_snapshotReason"]:
    require(forbidden_dev_runtime_member not in dev_runtime_commands, f"Godot devRuntimeCommands invents non-source module API/state: {forbidden_dev_runtime_member}")
require("RuntimeDevRuntimeCommandsScript.new" not in bootstrap and "var dev_runtime_commands" not in bootstrap, "Godot Game instantiates the source file-level devRuntimeCommands module")
apply_command_body = section(bootstrap, "func apply_runtime_command", "func _build_runtime_command_dependencies")
require("match type" not in apply_command_body and "RuntimeDevRuntimeCommandsScript.apply_dev_runtime_command(command, _build_runtime_command_dependencies())" in apply_command_body, "Godot Game does not call the file-level runtime-command function with per-call dependencies")
require("Callable(self, \"apply_runtime_command\")" in bootstrap, "Godot runtime-command transport bypasses Game.applyRuntimeCommand counterpart")
gd_snapshot_setup = gd_function(bootstrap, "setup_runtime_debug_snapshot_publishing")
gd_snapshot_schedule = gd_function(bootstrap, "schedule_runtime_debug_snapshot_publish")
gd_command_poll = gd_function(bootstrap, "poll_runtime_commands")
require(ordered_tokens(gd_snapshot_setup, [
    "if not OS.is_debug_build():", '"narrative:stateChanged"', '"flag:changed"',
    '"quest:accepted"', '"quest:completed"', '"dialogue:start"', '"dialogue:line"',
    '"dialogue:choices"', '"dialogue:end"', '"scene:enter"',
    'listen_event(event, Callable(self, "_schedule_runtime_debug_snapshot_from_event").bind(event))',
]), "Godot Game runtime debug snapshot event/listener architecture drift")
require(ordered_tokens(gd_snapshot_schedule, [
    "if not OS.is_debug_build():", "var token := RefCounted.new()",
    "runtime_debug_snapshot_timer = token", "create_timer(0.12).timeout",
    "runtime_debug_snapshot_timer != token", "runtime_debug_snapshot_timer = null",
    "await publish_runtime_debug_snapshot(reason)",
]), "Godot Game debounced runtime snapshot scheduling drift")
require(ordered_tokens(gd_command_poll, [
    "if not OS.is_debug_build() or runtime_command_poll_in_flight or runtime_command_bridge == null:",
    "runtime_command_poll_in_flight = true", "await runtime_command_bridge.poll_once()",
    "runtime_command_poll_in_flight = false",
]), "Godot Game native runtime-command poll boundary drift")

gd_debug_fixed = gd_function(bootstrap, "_debug_set_fixed_tick_mode")
gd_debug_steps = gd_function(bootstrap, "_debug_step_ticks")
gd_debug_click = gd_function(bootstrap, "_debug_click")
gd_debug_drag = gd_function(bootstrap, "_debug_drag")
gd_dispatch_pointer = gd_function(bootstrap, "_dispatch_pointer_like")
require(ordered_tokens(gd_debug_fixed, [
    "fixed_tick_mode = enabled", "set_process(not fixed_tick_mode)",
    "hud.set_fixed_tick_mode(enabled)", "if not fixed_tick_mode:", "return",
    "player.sprite.reset_animation_clock()", "scene_manager.reset_entity_animation_clocks()",
]), "Godot Game fixed-tick mode/HUD/entity clock order drift")
require(ordered_tokens(gd_debug_steps, [
    "clampi(ticks, 1, 200)", "clampf(dt_ms / 1000.0, 0.001, 0.1)",
    "tick(dt)", "hud.step_fixed_tick(dt)", "await _debug_yield_event_loop_turn()",
    "RenderingServer.force_draw()",
]), "Godot Game fixed-step tick/HUD/task/render order drift")
require(ordered_tokens(gd_debug_click, [
    '_dispatch_pointer_like("pointerdown"', '_dispatch_pointer_like("pointerup"',
    '_dispatch_pointer_like("click"', "await _debug_wait(50)",
]), "Godot Game debugClick pointer sequence drift")
require(ordered_tokens(gd_debug_drag, [
    '_dispatch_pointer_like("pointerdown"', "for index: int in range(1, steps + 1):",
    '_dispatch_pointer_like("pointermove"', "await _debug_wait(", '_dispatch_pointer_like("pointerup"',
]) and 'await _debug_wait(50)' not in gd_debug_drag, "Godot Game debugDrag pointer/timing sequence drift")
require(ordered_tokens(gd_dispatch_pointer, [
    'type == "pointermove"', "InputEventMouseMotion.new()", 'if type == "click":', "return",
    "InputEventMouseButton.new()", 'button.pressed = type != "pointerup"', "Input.parse_input_event(button)",
]), "Godot Game dispatchPointerLike engine adapter drift")
require(all(token in gd_javascript_runtime_adapter for token in ["failure_result", "truthy_string_or", "number_from_trimmed_string", "number_direct", "string_value"]), "JavaScript command primitive adapter surface drift")
require(any(adapter.get("target") == "godot_port/scripts/runtime/javascript_runtime_adapter.gd" for adapter in CODE_TRANSLATION_CONTRACT.get("engineAdapters", [])), "code translation contract does not declare the JavaScript command primitive adapter")

ts_deps_block = section(ts_dev_runtime_commands, "export type RuntimeCommandDeps =", "export async function applyDevRuntimeCommand")
ts_command_deps = re.findall(r"^\s{2}([A-Za-z][A-Za-z0-9]+)\(", ts_deps_block, flags=re.MULTILINE)
gd_deps_body = section(bootstrap, "func _build_runtime_command_dependencies", "func _capture_runtime_command_snapshot")
gd_command_deps = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', gd_deps_body, flags=re.MULTILINE)
require(ts_command_deps == CONTRACT["runtimeCommandDependencies"], f"TypeScript RuntimeCommandDeps drift: {ts_command_deps}")
require(gd_command_deps == CONTRACT["runtimeCommandDependencies"], f"Godot runtime-command dependency shape/order drift: {gd_command_deps}")
require('"navTargetActive": player_nav_target != null' in bootstrap, "Godot playerView does not expose Game-owned navigation state")

require("var patrol_generation" in bootstrap and "var npc_patrol_epoch" in bootstrap, "Godot bootstrap must own TS-equivalent patrol generation/epoch state")
require("func _run_npc_patrol" in bootstrap and "await npc.move_to" in bootstrap, "Godot patrol must use the Game-owned async coroutine path")
require("patrol_generation += 1" in section(bootstrap, "func _on_scene_before_unload_runtime_sync", "func _on_scene_ready_runtime_sync"), "scene unload must invalidate patrol generation before entity destruction")
require("_patrol_states" not in scene_manager and "func start_npc_patrol" not in scene_manager and "func stop_npc_patrol" not in scene_manager, "SceneManager still owns Game-level patrol state")
scene_update_body = re.sub(r"#.*", "", section(scene_manager, "func update(", "func set_player_position_setter"))
require("cutscene_update" not in scene_update_body and "patrol" not in scene_update_body, "SceneManager.update still advances Game-owned NPC/patrol logic")

ts_setup_scene_manager = section(game, "private setupSceneManager(): void", "private refreshPlayerWorldCollision(): void")
gd_setup_scene_manager = gd_function(bootstrap, "setup_scene_manager")
require(ordered_tokens(ts_setup_scene_manager, [
    "this.sceneManager.setPlayerPositionSetter", "this.sceneManager.setCameraSetter",
    "this.sceneManager.setBoundsOnlySetter", "this.sceneManager.setAudioApplier",
    "this.sceneManager.setAudioManifestResolver", "this.sceneManager.setZoneSetter",
    "this.sceneManager.setInteractionSetter", "this.sceneManager.setEntityFilterReleaser",
    "this.sceneManager.setDepthLoader", "this.sceneManager.setDepthUnloader",
    "this.sceneManager.setSceneEnterRunner",
]), "TypeScript Game.setupSceneManager ownership/order drift")
require(ordered_tokens(gd_setup_scene_manager, [
    "scene_manager.set_player_position_setter", "scene_manager.set_camera_setter",
    "scene_manager.set_bounds_only_setter", "scene_manager.set_audio_applier",
    "scene_manager.set_audio_manifest_resolver", "scene_manager.set_zone_setter",
    "scene_manager.set_interaction_setter", "scene_manager.set_entity_filter_releaser",
    "scene_manager.set_depth_loader", "scene_manager.set_depth_unloader",
    "scene_manager.set_scene_enter_runner",
]), "Godot Game.setup_scene_manager ownership/order drift")
require(re.search(r"^\s+setup_scene_manager\(\)\s*$", bootstrap, flags=re.MULTILINE) is not None, "Godot Game startup does not call setup_scene_manager")

ts_world_collision = section(game, "private refreshPlayerWorldCollision(): void", "private setupSceneLighting(")
gd_world_collision = gd_function(bootstrap, "refresh_player_world_collision")
gd_world_collision_callback = gd_function(bootstrap, "_is_player_world_collision")
require(ordered_tokens(ts_world_collision, [
    "this.player.setDepthCollision", "this.sceneDepthSystem.isCollision",
    "this.sceneManager.getCurrentHotspots()", "if (!h.active)", "hotspotCollisionPolygonToWorld",
    "this.sceneManager.getCurrentNpcs()", "if (!n.container.visible)", "npcCollisionPolygonToWorld",
]), "TypeScript Game.refreshPlayerWorldCollision composition/order drift")
require('player.set_depth_collision(Callable(self, "_is_player_world_collision"))' in gd_world_collision, "Godot Game.refresh_player_world_collision does not own the composed player collision callback")
require(ordered_tokens(gd_world_collision_callback, [
    "scene_depth_system.is_collision(world_x, world_y)",
    "scene_manager.get_current_hotspots()", "if not hotspot.get_active():",
    "RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(hotspot.def)",
    "RuntimeZoneGeometry.is_valid_zone_polygon(polygon)", "RuntimeZoneGeometry.is_point_in_polygon(polygon, world_x, world_y)",
    "scene_manager.get_current_npcs()", "if not npc.container.visible:",
    "RuntimeHotspotCollisionScript.npc_collision_polygon_to_world(npc)",
    "RuntimeZoneGeometry.is_valid_zone_polygon(polygon)", "RuntimeZoneGeometry.is_point_in_polygon(polygon, world_x, world_y)",
    "return false",
]), "Godot Game player world-collision composition/order drift")
require("npc.def.duplicate" not in gd_world_collision_callback and "RuntimeHotspot.collision_polygon_to_world" not in gd_world_collision_callback,
        "Godot Game retains a flattened NPC/hotspot collision conversion")

require(not re.search(r"^var (?:player|camera|scene_depth_system):", scene_manager, flags=re.MULTILINE), "Godot SceneManager directly owns Game-level Player/Camera/SceneDepthSystem")
for setter in ["set_player_position_setter", "set_camera_setter", "set_bounds_only_setter", "set_depth_loader", "set_depth_unloader"]:
    require(f"func {setter}" in scene_manager, f"Godot SceneManager dependency callback missing: {setter}")
for wiring in ["set_player_position_setter", "set_camera_setter", "set_bounds_only_setter", "set_depth_loader", "set_depth_unloader"]:
    require(f"scene_manager.{wiring}" in bootstrap, f"bootstrap does not inject SceneManager dependency: {wiring}")
require("set_scene_depth_system" not in scene_manager and "set_scene_depth_system" not in bootstrap, "SceneManager regressed to direct SceneDepthSystem injection")
require("scene_depth_system.update" not in section(scene_manager, "func load_scene", "func unload_scene"), "SceneManager owns Game-level depth entity assembly")
require(not re.search(r"^var (?:scene_manager|player|renderer):", scene_depth, flags=re.MULTILINE), "Godot SceneDepthSystem directly owns Game-level scene/player/renderer references")
require("bind_runtime" not in scene_depth and "set_condition_evaluator" not in scene_depth, "Godot SceneDepthSystem still has a Game-owned runtime/context binding")
depth_update_body = re.sub(r"#.*", "", section(scene_depth, "func update(", "func serialize"))
require(all(token not in depth_update_body for token in ["get_current_npcs", "get_current_hotspots", "update_sprite_entity", "update_entity_shadow"]), "Godot SceneDepthSystem.update still owns per-entity assembly")
depth_frame = gd_function(bootstrap, "_update_scene_depth_runtime")
require(ordered_tokens(depth_frame, [
    "scene_depth_system.update_per_frame", "scene_depth_system.update_entity_depth_occlusion(player_depth_filter",
    "scene_manager.get_current_npcs()", "scene_depth_system.update_entity_depth_occlusion(filter",
    "scene_manager.get_current_hotspots()", "scene_depth_system.update_entity_depth_occlusion(filter",
]), "Godot bootstrap depth/filter frame ownership/order drift")
require(all(token not in depth_frame for token in [
    "_sync_entity_pixel_density_match", "update_light_env_from_curve", "update_entity_shadows",
]), "Godot _update_scene_depth_runtime still folds density/light/shadow phases into the depth phase")
require(all(token in bootstrap for token in [
    "var player_depth_filter", "var current_probe", "var current_light_env", "var current_light_curve",
    "var plane_light_env_override", "var current_shadow_field", "var entity_shadows",
    "func setup_scene_lighting(", "func rebuild_entity_shadows(", "func create_shadow_impl(",
    "func apply_shadow_and_ao(", "func resolve_light_curve_into(", "func apply_plane_light_env_override(",
    "func update_light_env_from_curve(", "func update_entity_shadows(", "func clear_entity_shadows(",
]), "Godot Game/bootstrap did not reclaim source Game lighting/shadow fields and methods from SceneDepthSystem")
require("RuntimeDepthFloorZones.resolve" in bootstrap and "scene_manager.is_entity_in_active_plane(zone)" in bootstrap, "Godot Game/bootstrap does not own central/plane-filtered depth-floor evaluation")
require("player.set_depth_collision(Callable(self, \"_is_player_world_collision\"))" in bootstrap, "Godot player collision composition is not owned by Game/bootstrap")

require(ordered_tokens(game, [
    "private setupSceneManager(): void", "private refreshPlayerWorldCollision(): void",
    "private setupSceneLighting(", "private setupSceneReadyHandler(): void",
    "private attachNpcSceneFilters(", "private startNpcPatrolIfEligible(",
    "private attachHotspotDepthFilter(",
]), "TypeScript Game scene lifecycle method architecture/order drift")
require(ordered_tokens(bootstrap, [
    "func setup_scene_manager(", "func refresh_player_world_collision(",
    "func setup_scene_lighting(", "func setup_scene_ready_handler(",
    "func attach_npc_scene_filters(", "func _start_npc_patrol_if_eligible(",
    "func attach_hotspot_depth_filter(",
]), "Godot Game scene lifecycle method architecture/order drift")
for lifecycle_method in [
    "setup_scene_manager", "refresh_player_world_collision", "setup_scene_lighting",
    "setup_scene_ready_handler", "attach_npc_scene_filters", "_start_npc_patrol_if_eligible",
    "attach_hotspot_depth_filter", "_sync_entity_pixel_density_match",
]:
    require(len(re.findall(rf"^func {re.escape(lifecycle_method)}\(", bootstrap, flags=re.MULTILINE)) == 1, f"Godot Game scene lifecycle method is missing or duplicated: {lifecycle_method}")
require("_attach_scene_depth_filters" not in bootstrap, "Godot Game retains the target-only all-scene depth-filter monolith")

gd_depth_loader = gd_function(bootstrap, "_load_scene_depth_runtime")
require(ordered_tokens(gd_depth_loader, [
    "scene_depth_system.load(", "scene_depth_system.load_default()",
    "setup_scene_lighting(", "refresh_player_world_collision()",
]), "Godot scene depth loader does not preserve load/loadDefault -> lighting -> collision order")
require(all(token not in gd_depth_loader for token in [
    "create_filter_for_entity", "create_lighting_filter_for_entity", "attach_depth_occlusion_filter",
    "attach_npc_scene_filters", "attach_hotspot_depth_filter", "rebuild_entity_shadows",
    "apply_shadow_and_ao", "_sync_entity_pixel_density_match", "_update_scene_depth_runtime",
    "apply_entity_pixel_density_match", "update_entity_shadows",
]), "Godot scene depth loader performs scene:ready filter/shadow/density assembly too early")

gd_depth_unloader = gd_function(bootstrap, "_unload_scene_depth_runtime")
require(ordered_tokens(gd_depth_unloader, [
    "scene_depth_system.unload()", "refresh_player_world_collision()",
    "RuntimeSceneEntityFilterBinding.detach(player.sprite.container)", "player_depth_filter = null",
    "clear_entity_shadows()", "current_probe = null", "current_light_env = null",
    "current_light_curve = null", "current_shadow_field = null",
]), "Godot scene depth unloader cleanup/order drift")

ts_setup_lighting = section(game, "private setupSceneLighting(", "private rebuildEntityShadows(): void")
gd_setup_lighting = gd_function(bootstrap, "setup_scene_lighting")
require(ordered_tokens(ts_setup_lighting, [
    "this.sceneManager.getPrimaryBackgroundTexture()", "buildIrradianceProbe(",
    "this.sceneDepthSystem.enableLighting(",
]), "TypeScript Game.setupSceneLighting primary-background ownership drift")
require(ordered_tokens(gd_setup_lighting, [
    "scene_manager.get_primary_background_texture()", "RuntimeSceneDepthFilterAdapter.build_probe_texture(",
    "scene_depth_system.enable_lighting(",
]), "Godot Game.setup_scene_lighting does not use SceneManager's committed primary background texture")
require("asset_manager.load_texture" not in gd_setup_lighting and 'scene.get("backgrounds"' not in gd_setup_lighting, "Godot Game.setup_scene_lighting reloads raw scene background data instead of using SceneManager ownership")

shadow_method_pairs = [
    ("private rebuildEntityShadows(", "func rebuild_entity_shadows("),
    ("private rebuildEntityShadowsForIds(", "func rebuild_entity_shadows_for_ids("),
    ("private destroyEntityShadowEntry(", "func destroy_entity_shadow_entry("),
    ("private buildNpcShadowEntry(", "func build_npc_shadow_entry("),
    ("private buildHotspotShadowEntry(", "func build_hotspot_shadow_entry("),
    ("private createShadowImpl(", "func create_shadow_impl("),
    ("private applyShadowAndAO(", "func apply_shadow_and_ao("),
    ("private updateEntityShadows(", "func update_entity_shadows("),
    ("private makePlayerShadowSource(", "func make_player_shadow_source("),
    ("private makeNpcShadowSource(", "func make_npc_shadow_source("),
    ("private makeHotspotShadowSource(", "func make_hotspot_shadow_source("),
    ("private clearEntityShadows(", "func clear_entity_shadows("),
]
require(ordered_tokens(game, [source for source, _target in shadow_method_pairs]), "TypeScript Game entity-shadow method architecture/order drift")
require(ordered_tokens(bootstrap, [target for _source, target in shadow_method_pairs]), "Godot Game entity-shadow method architecture/order drift")
for _source_method, target_method in shadow_method_pairs:
    target_name = target_method.removeprefix("func ").removesuffix("(")
    require(len(re.findall(rf"^func {re.escape(target_name)}\(", bootstrap, flags=re.MULTILINE)) == 1, f"Godot Game entity-shadow method is missing or duplicated: {target_name}")

gd_shadow_rebuild = gd_function(bootstrap, "rebuild_entity_shadows")
gd_shadow_npc_build = gd_function(bootstrap, "build_npc_shadow_entry")
gd_shadow_hotspot_build = gd_function(bootstrap, "build_hotspot_shadow_entry")
for shadow_entry_body, shadow_entry_label in [
    (gd_shadow_rebuild, "player"),
    (gd_shadow_npc_build, "NPC"),
    (gd_shadow_hotspot_build, "hotspot"),
]:
    require(ordered_tokens(shadow_entry_body, ['"shadow":', '"src":', '"owner":']), f"Godot {shadow_entry_label} shadow entry does not preserve shadow/src/owner identity fields")

gd_shadow_targeted = gd_function(bootstrap, "rebuild_entity_shadows_for_ids")
gd_shadow_targeted_npcs = section(gd_shadow_targeted, "for raw_id: Variant in npc_ids:", "for raw_id: Variant in hotspot_ids:")
gd_shadow_targeted_hotspots = section(gd_shadow_targeted, "for raw_id: Variant in hotspot_ids:", "func destroy_entity_shadow_entry(")
require(ordered_tokens(gd_shadow_targeted_npcs, [
    "destroy_entity_shadow_entry(id)", "if not shadows_on:", "scene_manager.get_npc_by_id(id)",
]), "Godot targeted NPC shadow rebuild does not destroy the old entry before mode/instance checks")
require(ordered_tokens(gd_shadow_targeted_hotspots, [
    'destroy_entity_shadow_entry("hotspot:%s" % id)', "if not shadows_on:", "scene_manager.get_current_hotspots()",
]), "Godot targeted hotspot shadow rebuild does not destroy the old entry before mode/instance checks")

gd_shadow_destroy = gd_function(bootstrap, "destroy_entity_shadow_entry")
gd_shadow_clear = gd_function(bootstrap, "clear_entity_shadows")
require(ordered_tokens(gd_shadow_destroy, [
    "scene_depth_system.unregister_shadow(entry.shadow)", "entry.shadow.destroy()", "entity_shadows.erase(key)",
]), "Godot single shadow-entry cleanup must unregister -> destroy -> erase")
require(ordered_tokens(gd_shadow_clear, [
    "scene_depth_system.unregister_shadow(entry.shadow)", "entry.shadow.destroy()", "entity_shadows.clear()",
]), "Godot all-shadow cleanup must unregister -> destroy -> clear")

gd_shadow_update = gd_function(bootstrap, "update_entity_shadows")
require("{" not in gd_shadow_update and all(token not in gd_shadow_update for token in [
    '"getFootX"', '"getFootY"', '"getWorldWidth"', '"getWorldHeight"', '"getTexture"', '"getFacing"', '"isVisible"',
]), "Godot update_entity_shadows rebuilds per-frame ShadowSource dictionaries")
require(len(re.findall(r"\.src\s*=", gd_shadow_update)) == 2, "Godot update_entity_shadows mutates cached ShadowSource outside the two owner-swap paths")
require(re.search(
    r"if not is_same\(entry\.owner, npc\):\s+entry\.owner = npc\s+entry\.src = make_npc_shadow_source\(npc\)",
    gd_shadow_update,
) is not None, "Godot NPC ShadowSource is not replaced only when owner identity changes")
require(re.search(
    r"if not is_same\(entry\.owner, hotspot\):\s+entry\.owner = hotspot\s+entry\.src = make_hotspot_shadow_source\(hotspot\)",
    gd_shadow_update,
) is not None, "Godot hotspot ShadowSource is not replaced only when owner identity changes")
require(gd_shadow_update.count("make_npc_shadow_source(npc)") == 1 and gd_shadow_update.count("make_hotspot_shadow_source(hotspot)") == 1 and "make_player_shadow_source(" not in gd_shadow_update, "Godot update_entity_shadows does not reuse cached ShadowSource instances")

require("../../public/assets/data/runtime_field_schema.json" in read("src/data/EntityRuntimeFieldSchema.ts"), "TypeScript runtime-field schema is not sourced from shared exportable JSON")
require('const SCHEMA_URL := "/assets/data/runtime_field_schema.json"' in entity_runtime_field_schema, "Godot runtime-field schema is not sourced from shared exportable JSON")
require("RuntimeEntityRuntimeFieldSchema.configure(asset_manager)" in bootstrap, "Godot Game does not initialize the imported EntityRuntimeFieldSchema module")
require("RuntimeEntityRuntimeFieldSchema.coerce_value" in bootstrap and "RuntimeEntityRuntimeFieldSchema.coerce_value" in scene_manager, "Game and SceneManager do not import the shared EntityRuntimeFieldSchema module")
require("RuntimeEntityRuntimeFieldSchemaScript.new" not in bootstrap + scene_manager and "entity_runtime_field_schema:" not in bootstrap and "_runtime_field_schema" not in scene_manager, "Godot turned the source EntityRuntimeFieldSchema file module into owned Game/SceneManager instances")

require(ordered_tokens(ts_scene_manager, [
    "private assetManager", "private eventBus", "private renderer", "private currentScene", "private currentHotspots",
    "private currentNpcs", "private sceneContainerBg", "private sceneMemory", "private cutsceneStaging",
    "private characterRegistry", "private zoneSessionDisabled", "private entitySessionOverrides", "private sceneEpoch",
    "private sceneEnterBatchDepth", "private pendingReentrantSwitch", "private transitionOverlay",
    "private transitionBarFill", "private transitionBarW", "private transitionBarH", "private transitionDebugLabel",
    "private isSwitching", "private sceneSwitchTail", "private animRafId", "private activeCutsceneBindingId",
    "private activePlaneGetter", "private playerPositionSetter", "private cameraSetter", "private boundsOnlySetter",
    "private audioApplier", "private audioManifestResolver", "private zoneSetter", "private interactionSetter",
    "private entityFilterReleaser", "private depthLoader", "private depthUnloader", "private sceneEnterRunner",
    "private currentSceneScopeId", "private onHotspotPickup", "private onHotspotInspected",
]), "TypeScript SceneManager field architecture/order drift")
require(ordered_tokens(scene_manager, [
    "var asset_manager", "var event_bus", "var renderer", "var current_scene", "var current_hotspots", "var current_npcs",
    "var scene_background", "var scene_memory", "var cutscene_staging", "var character_registry",
    "var zone_session_disabled", "var entity_session_overrides", "var _scene_epoch", "var _scene_enter_batch_depth",
    "var _pending_reentrant_switch", "var _transition_overlay", "var _transition_bar_fill",
    "var _transition_bar_width", "var _transition_bar_height", "var _transition_debug_label", "var _switching",
    "var _scene_switch_tail", "var _animation_tween", "var active_cutscene_binding_id", "var _active_plane_getter",
    "var _player_position_setter", "var _camera_setter", "var _bounds_only_setter", "var _audio_applier",
    "var _audio_manifest_resolver", "var _zone_setter", "var _interaction_setter", "var _entity_filter_releaser",
    "var _depth_loader", "var _depth_unloader", "var _scene_enter_runner", "var _current_scene_scope_id",
    "var _on_hotspot_pickup", "var _on_hotspot_inspected",
]), "Godot SceneManager field architecture/order drift")

require(ordered_tokens(ts_scene_manager, [
    "setCharacterRegistry(", "constructor(", "init(", "update(", "setPlayerPositionSetter(", "setCameraSetter(",
    "setBoundsOnlySetter(", "setAudioApplier(", "setAudioManifestResolver(", "setZoneSetter(",
    "setInteractionSetter(", "setEntityFilterReleaser(", "releaseHotspotFilters(", "releaseNpcFilters(",
    "setDepthLoader(", "setDepthUnloader(", "setSceneEnterRunner(", "get currentSceneData", "getNpcById(",
    "getCurrentNpcs(", "getCurrentHotspots(", "setActiveCutsceneBindingId(", "getActiveCutsceneBindingId(",
    "setActivePlaneGetter(", "entityInPlane(", "isEntityInActivePlane(", "refreshCutsceneBoundEntityVisibility(",
    "refreshForPlaneChange(", "refreshEntitiesForPlaneChange(", "refreshZonesForPlaneChange(",
    "setEntitySessionEnabled(", "applySessionOverrideOnInstantiate(", "getHotspotBaseEnabledForInteraction(",
    "getNpcBaseVisibleForInteraction(", "setZoneEnabledSession(", "mergePersistentZoneEnabled(", "resolveZoneKind(",
    "findZoneDefInScene(", "getMergedZoneOverride(", "computeEffectiveZones(", "shouldRegisterZoneWithZoneSystem(",
    "refreshZonesAfterRuntimeChange(", "get switching", "emptyEntityOverrides(", "createEmptyMemory(",
    "normalizeMemory(", "ensureSceneMemory(", "beginCutsceneStaging(", "endCutsceneStaging(",
    "enterCutsceneInstancesForCurrent(", "exitCutsceneInstancesForCurrent(", "commitRebuiltEntityOrDiscard",
    "emitEntitiesRebuilt(", "isCutsceneStagingActive(", "getActiveCutsceneStagingSceneId(",
    "getActiveCutsceneStagingId(", "getCommittedMemory(", "getWritableMemory(", "findEntityDef(",
    "isCurrentCutsceneOnlyEntity(", "getEntityRuntimeOverrideForDef(", "getRuntimeOverrideForContext(",
    "mergeHotspotDisplayImageOverride(", "setEntityRuntimeField(", "getEntityRuntimeOverride(",
    "mergePersistentNpcState(", "isNpcPatrolPersistentlyDisabled(", "applyDebugWorldSize(",
    "getBackgroundTexelsPerWorld(", "getDebugRenderState(", "getDebugEntityVisualState(",
    "resetEntityAnimationClocks(", "getPrimaryBackgroundTexture(", "instantiateHotspot(", "instantiateNpc(",
    "countSceneInstantiateWork(", "buildSceneResourceManifest(", "async loadScene(", "async loadInitialScene(", "applyPlayerSpawnAndCamera(",
    "unloadScene(", "async switchScene(", "consumePendingReentrantSwitch(", "saveCurrentSceneMemory(",
    "markHotspotPickedUp(", "markHotspotInspected(", "fadeOut(", "fadeIn(", "ensureTransitionOverlay(",
    "setTransitionOverlayProgress(", "removeTransitionOverlay(", "animateAlpha(", "serialize(", "deserialize(", "destroy(",
]), "TypeScript SceneManager method architecture/order drift")
require(ordered_tokens(scene_manager, [
    "func set_character_registry(", "func _init(", "func init(", "func update(", "func set_player_position_setter(",
    "func set_camera_setter(", "func set_bounds_only_setter(", "func set_audio_applier(",
    "func set_audio_manifest_resolver(", "func set_zone_setter(", "func set_interaction_setter(",
    "func set_entity_filter_releaser(", "func _release_hotspot_filters(", "func _release_npc_filters(",
    "func set_depth_loader(", "func set_depth_unloader(", "func set_scene_enter_runner(",
    "func get_current_scene_data(", "func get_npc_by_id(", "func get_current_npcs(", "func get_current_hotspots(",
    "func set_active_cutscene_binding_id(", "func get_active_cutscene_binding_id(", "func set_active_plane_getter(",
    "func _entity_in_plane(", "func is_entity_in_active_plane(", "func _refresh_cutscene_bound_entity_visibility(",
    "func refresh_for_plane_change(", "func refresh_entities_for_plane_change(", "func refresh_zones_for_plane_change(",
    "func set_entity_session_enabled(", "func _apply_session_override_on_instantiate(",
    "func get_hotspot_base_enabled_for_interaction(", "func get_npc_base_visible_for_interaction(",
    "func set_zone_enabled_session(", "func merge_persistent_zone_enabled(", "func _resolve_zone_kind(",
    "func _find_zone_definition(", "func _merged_zone_override(", "func _compute_effective_zones(",
    "func _should_register_zone_with_zone_system(", "func _refresh_zones_after_runtime_change(",
    "func is_switching(", "func _empty_entity_overrides(", "func _empty_memory(", "func _normalize_memory(",
    "func _ensure_scene_memory(", "func begin_cutscene_staging(", "func end_cutscene_staging(",
    "func enter_cutscene_instances_for_current(", "func exit_cutscene_instances_for_current(",
    "func _commit_rebuilt_entity_or_discard(", "func _emit_entities_rebuilt(", "func is_cutscene_staging_active(",
    "func get_active_cutscene_staging_scene_id(", "func get_active_cutscene_staging_id(",
    "func _get_committed_memory(", "func _get_writable_memory(", "func _find_entity_definition(",
    "func _is_current_cutscene_only_entity(", "func _entity_runtime_override_for_definition(",
    "func _runtime_override_for_context(", "func merge_hotspot_display_image_override(",
    "func set_entity_runtime_field(", "func get_entity_runtime_override(", "func merge_persistent_npc_state(",
    "func is_npc_patrol_persistently_disabled(", "func apply_debug_world_size(",
    "func get_background_texels_per_world(", "func get_debug_render_state(", "func get_debug_entity_visual_state(",
    "func reset_entity_animation_clocks(", "func get_primary_background_texture(", "func _instantiate_hotspot(",
    "func _instantiate_npc(", "func _count_scene_instantiate_work(", "func _build_scene_resource_manifest(",
    "func load_scene(", "func load_initial_scene(", "func _apply_spawn_and_camera(", "func unload_scene(", "func switch_scene(",
    "func _consume_pending_reentrant_switch(", "func _save_current_scene_memory(", "func _mark_hotspot_picked_up(",
    "func _mark_hotspot_inspected(", "func _fade_out(", "func _fade_in(", "func _ensure_transition_overlay(",
    "func _set_transition_overlay_progress(", "func _remove_transition_overlay(", "func _animate_alpha(",
    "func serialize(", "func deserialize(", "func destroy(",
]), "Godot SceneManager method architecture/order drift")
require(all(token not in scene_manager for token in ["diagnostics", "get_diagnostics", "_start_scene_entry", "_run_scene_entry", "func get_hotspot_by_id("]), "Godot SceneManager retains non-source diagnostic/entry/helper API architecture")
scene_field_store = section(scene_manager, "func set_entity_runtime_field", "func get_entity_runtime_override")
scene_merge_npc = section(scene_manager, "func merge_persistent_npc_state", "func is_npc_patrol_persistently_disabled")
require("_apply_runtime_field_to_live" not in scene_manager, "SceneManager still owns Game-level live runtime-field application")
require("func set_hotspot_display_image" not in scene_manager and "func temp_set_hotspot_display_facing" not in scene_manager, "SceneManager still owns Game-level hotspot action adapters")
require("RuntimeEntityRuntimeFieldSchema.coerce_value" in scene_field_store and "_apply" not in scene_field_store, "SceneManager setEntityRuntimeField must validate/store without applying live state")
require("_apply" not in scene_merge_npc, "SceneManager mergePersistentNpcState must store without applying live state")
require('"setSceneEntityField": Callable(self, "_set_scene_entity_field_from_action")' in bootstrap, "ActionRegistry setSceneEntityField dependency is not Game-owned")
require('"setHotspotDisplayImage": Callable(self, "_set_hotspot_display_image_from_action")' in bootstrap, "ActionRegistry setHotspotDisplayImage dependency is not Game-owned")
require('"tempSetHotspotDisplayFacing": Callable(self, "_temp_set_hotspot_display_facing_from_action")' in bootstrap, "ActionRegistry tempSetHotspotDisplayFacing dependency is not Game-owned")
game_field_apply = section(bootstrap, "func _set_scene_entity_field_from_action", "func _set_hotspot_display_image_from_action")
require(ordered_tokens(game_field_apply, ["RuntimeEntityRuntimeFieldSchema.coerce_value", "scene_manager.set_entity_runtime_field", "_apply_npc_runtime_field_now", "_apply_hotspot_runtime_field_now"]), "Godot Game runtime-field validate/store/apply boundary drift")
require(ordered_tokens(game, [
    "private async setSceneEntityFieldFromAction(", "private async setHotspotDisplayImageFromAction(",
    "private tempSetHotspotDisplayFacingFromAction(", "private async applyNpcRuntimeFieldNow(",
    "private async applyHotspotRuntimeFieldNow(", "private async applyHotspotDisplayImageNow(",
    "private syncEntityPixelDensityMatch(",
]), "TypeScript Game hotspot-display method-chain architecture/order drift")
require(ordered_tokens(bootstrap, [
    "func _set_scene_entity_field_from_action(", "func _set_hotspot_display_image_from_action(",
    "func _temp_set_hotspot_display_facing_from_action(", "func _apply_npc_runtime_field_now(",
    "func _apply_hotspot_runtime_field_now(", "func _apply_hotspot_display_image_now(",
    "func _sync_entity_pixel_density_match(",
]), "Godot Game hotspot-display method-chain architecture/order drift")
ts_hotspot_action = section(game, "private async setHotspotDisplayImageFromAction(", "private tempSetHotspotDisplayFacingFromAction(")
gd_hotspot_action = section(bootstrap, "func _set_hotspot_display_image_from_action(", "func _temp_set_hotspot_display_facing_from_action(")
require(ordered_tokens(ts_hotspot_action, [
    "const sid = sceneId.trim()", "this.assetManager.resolveSceneAssetPath", "await this.assetManager.loadTexture(pathResolved)",
    "await this.assetManager.loadSceneData(sid)", "this.sceneManager.getEntityRuntimeOverride", "const prev =",
    "if (pW !== undefined && pH !== undefined)", "else if (pW !== undefined)", "else if (pH !== undefined)",
    "else if (hasW && hasH)", "else if (hasW)", "else if (hasH)", "ww = 100",
    "await this.setSceneEntityFieldFromAction",
]), "TypeScript setHotspotDisplayImage transaction/dimension contract drift")
require(ordered_tokens(gd_hotspot_action, [
    "var sid := scene_id.strip_edges()", "asset_manager.resolve_scene_asset_path", "asset_manager.load_texture(path_resolved)",
    "asset_manager.load_scene_data(sid)", "scene_manager.get_entity_runtime_override", "var previous:",
    "if requested_width != null and requested_height != null", "elif requested_width != null", "elif requested_height != null",
    "elif has_previous_width and has_previous_height", "elif has_previous_width", "elif has_previous_height", "width = 100.0",
    "await _set_scene_entity_field_from_action",
]), "Godot setHotspotDisplayImage transaction/dimension contract drift")
ts_hotspot_apply = section(game, "private async applyHotspotRuntimeFieldNow(", "private syncEntityPixelDensityMatch(")
gd_hotspot_apply = gd_function(bootstrap, "_apply_hotspot_runtime_field_now") + gd_function(bootstrap, "_apply_hotspot_display_image_now")
require(ordered_tokens(ts_hotspot_apply, [
    "delete h.def.displayImage", "h.detachDepthOcclusionFilter()", "this.sceneDepthSystem.removeFilter(oldF)",
    "oldF.destroy()", "h.setDisplayTexture(Texture.EMPTY, 0, 0)", "await this.applyHotspotDisplayImageNow(h, value)",
    "this.syncEntityPixelDensityMatch()", "await this.assetManager.loadTexture(displayImage.image)",
    "const oldF = h.detachDepthOcclusionFilter()", "this.sceneDepthSystem.removeFilter(oldF)", "oldF.destroy()",
    "h.def.displayImage = displayImage", "h.setDisplayTexture", "this.sceneDepthSystem.createFilterForEntity()",
    "h.attachDepthOcclusionFilter(hf)",
]), "TypeScript hotspot display live-apply transaction/filter ownership drift")
require(ordered_tokens(gd_hotspot_apply, [
    'hotspot.def.erase("displayImage")', "hotspot.detach_depth_occlusion_filter()", "scene_depth_system.remove_filter(old_filter)",
    "old_filter.destroy()", "hotspot.set_display_texture(null, 0.0, 0.0)", "await _apply_hotspot_display_image_now(hotspot, value)",
    "_sync_entity_pixel_density_match()", "asset_manager.load_texture(str(display_image.image))",
    "hotspot.detach_depth_occlusion_filter()", "scene_depth_system.remove_filter(old_filter)", "old_filter.destroy()",
    "hotspot.def.displayImage = display_image", "hotspot.set_display_texture", "scene_depth_system.create_filter_for_entity()",
    "hotspot.attach_depth_occlusion_filter(next_filter)",
]), "Godot hotspot display live-apply transaction/filter ownership drift")
require("_update_scene_depth_runtime()" not in gd_hotspot_apply, "Godot hotspot field apply still triggers target-only whole-scene depth/filter rebuild")
require("RuntimeSceneEntityFilterBinding" not in gd_function(bootstrap, "_apply_hotspot_display_image_now"), "Godot Game bypasses Hotspot-owned depth-filter binding during display replacement")
ts_hotspot_texture = section(ts_hotspot_entity, "setDisplayTexture(", "private _effectiveDisplayFacing(")
gd_hotspot_texture = section(gd_hotspot_entity, "func set_display_texture(", "func set_runtime_display_facing(")
require(ordered_tokens(ts_hotspot_texture, ["this.displaySprite.filters = []", "this.displaySprite.destroy()", "this.pixelDensityBlur.destroy()", "this._displayWorldHeight = 0", "new Sprite(texture)", "this.displaySprite = spr"]), "TypeScript Hotspot display texture teardown/rebuild ownership drift")
require(ordered_tokens(gd_hotspot_texture, ["RuntimeSceneEntityFilterBinding.detach(display_sprite)", "display_sprite.free()", "_pixel_density_match_active = false", "_display_world_height = 0.0", "display_sprite = Sprite2D.new()", "_display_world_height = world_height"]), "Godot Hotspot display texture teardown/rebuild ownership drift")
gd_hotspot_filter_methods = section(gd_hotspot_entity, "func attach_depth_occlusion_filter(", "func apply_entity_pixel_density_match(")
require(ordered_tokens(gd_hotspot_filter_methods, ["_depth_occlusion_filter = filter", "_rebuild_display_sprite_filter()", "var result:", "_depth_occlusion_filter = null", "_rebuild_display_sprite_filter()", "return result"]), "Godot Hotspot attach/detach filter ownership drift")
gd_hotspot_filter_rebuild = section(gd_hotspot_entity, "func _rebuild_display_sprite_filter(", "static func _is_valid_polygon(")
require(ordered_tokens(gd_hotspot_filter_rebuild, ["RuntimeSceneEntityFilterBinding.detach(display_sprite)", "RuntimeSceneEntityFilterBinding.attach(display_sprite, _depth_occlusion_filter)"]), "Godot Hotspot does not own its display-sprite depth binding")
require(ordered_tokens(section(bootstrap, "scene_manager.set_entity_filter_releaser(", "scene_manager.set_depth_loader("), ["scene_depth_system.remove_filter(filter)", "filter.destroy()"]), "Godot Game entity-filter releaser omits remove-then-destroy ownership")
require("func destroy() -> void:" in gd_entity_lighting_filter and "material = null" in gd_entity_lighting_filter, "Godot entity filter lacks explicit GPU-resource destruction boundary")
entity_actions = section(action_registry, "static func register_action_handlers", "static func audit_action_registrations")
require("sceneManager.set_entity_runtime_field" not in entity_actions, "Godot ActionRegistry bypasses its setSceneEntityField dependency")
require("await d.setSceneEntityField.call" in entity_actions and "await d.setHotspotDisplayImage.call" in entity_actions, "Godot entity actions do not await Game-owned mutation adapters")

ts_load = section(ts_scene_manager, "async loadScene(", "async loadInitialScene(")
gd_load = section(scene_manager, "func load_scene(", "func load_initial_scene(")
require(ordered_tokens(ts_load, ["onLoadProgress?", "onReveal?", "await onReveal()", "await this.sceneEnterRunner"]), "TypeScript SceneManager loadScene callback/entry contract drift")
require(ordered_tokens(gd_load, ["on_load_progress: Callable", "on_reveal: Callable", "await on_reveal.call()", "await _scene_enter_runner.call"]), "Godot SceneManager load_scene callback/entry contract drift")
ts_initial_load = section(ts_scene_manager, "async loadInitialScene(", "private applyPlayerSpawnAndCamera")
gd_initial_load = section(scene_manager, "func load_initial_scene(", "func _apply_spawn_and_camera(")
require(ordered_tokens(ts_initial_load, [
    "this.ensureTransitionOverlay()", "this.transitionOverlay!.alpha = 1", "const reveal =",
    "this.fadeIn(400)", "await this.loadScene(", "this.setTransitionOverlayProgress",
    "this.removeTransitionOverlay()", "throw e",
]), "TypeScript SceneManager loadInitialScene architecture drift")
require(ordered_tokens(gd_initial_load, [
    "_ensure_transition_overlay()", "_transition_overlay.modulate.a = 1.0", "var reveal :=",
    "_fade_in(400.0)", "await load_scene(", 'Callable(self, "_set_transition_overlay_progress")',
    "if not loaded:", "_remove_transition_overlay()", "return loaded",
]), "Godot SceneManager load_initial_scene architecture/order drift")
for forbidden_scene_api in ["switch_scene_and_wait", "wait_for_current_scene_entry", "set_scene_reveal_runner"]:
    require(forbidden_scene_api not in scene_manager, f"Godot SceneManager retains invented public API: {forbidden_scene_api}")
require("unload_scene()" not in gd_load, "Godot load_scene owns unload despite TypeScript loadScene/switchScene boundary")
gd_switch = section(scene_manager, "func switch_scene(", "func _consume_pending_reentrant_switch")
require("RuntimeAsyncTail" in scene_manager and "_scene_switch_tail.then" in gd_switch, "Godot switch_scene must translate the single SceneManager.sceneSwitchTail Promise chain through RuntimeAsyncTail")
require(all(token not in scene_manager for token in [
    "_scene_switch_queue", "_scene_switch_queue_running", "_active_scene_switch_request",
    "_zone_actions_waiter", "set_zone_actions_waiter", "_scene_entry_epoch", "_scene_entry_running_epoch",
]), "Godot SceneManager retains target-invented queue/wait/entry-epoch architecture")
for required_scene_setter in ["set_audio_manifest_resolver", "set_entity_filter_releaser"]:
    require(f"func {required_scene_setter}" in scene_manager, f"Godot SceneManager omits source-owned dependency setter: {required_scene_setter}")
for required_scene_wiring in ["set_audio_manifest_resolver", "set_entity_filter_releaser"]:
    require(f"scene_manager.{required_scene_wiring}" in bootstrap, f"Godot Game/bootstrap does not inject source SceneManager dependency: {required_scene_wiring}")
require("asset_manager.load_scene_data" in gd_load and "_build_scene_resource_manifest" in gd_load and "asset_manager.preload_manifest" in gd_load, "Godot SceneManager load_scene bypasses source AssetManager loadSceneData/manifest pipeline")
require("_current_scene_scope_id" in scene_manager and "asset_manager.release_scope" in section(scene_manager, "func unload_scene", "func get_current_scene_data"), "Godot SceneManager omits source scene asset-scope ownership")
require("func set_character_registry" in scene_manager and "character_registry.json" not in section(scene_manager, "func init(", "func update("), "Godot SceneManager must receive the Game-loaded character registry instead of loading it in init")
require(ordered_tokens(ts_load, [
    "this.interactionSetter?.", "this.applyPlayerSpawnAndCamera", "this.audioApplier?.",
    "this.zoneSetter?.", "this.depthLoader", "this.renderer.loadAndSetWorldFilter",
    "this.eventBus.emit('scene:enter'", "this.eventBus.emit('scene:ready'",
]), "TypeScript SceneManager load commit order drift")
require(ordered_tokens(gd_load, [
    "_interaction_setter.call", "_apply_spawn_and_camera", "_audio_applier.call",
    "_zone_setter.call", "_depth_loader.call", "renderer.load_and_set_world_filter",
    'event_bus.emit("scene:enter"', 'event_bus.emit("scene:ready"',
]), "Godot SceneManager load commit order drift")
ts_unload = section(ts_scene_manager, "unloadScene(): void", "async switchScene")
gd_unload = section(scene_manager, "func unload_scene", "func get_current_scene_data")
require(ordered_tokens(ts_unload, [
    "this.eventBus.emit('scene:beforeUnload'", "this.interactionSetter?.([], [])",
    "this.depthUnloader?.()", "this.zoneSetter?.([])", "this.currentScene = null",
]), "TypeScript SceneManager unload order drift")
require(ordered_tokens(gd_unload, [
    'event_bus.emit("scene:beforeUnload"', "_interaction_setter.call([], [])",
    "_depth_unloader.call", "_zone_setter.call([])", "current_scene.clear()",
]), "Godot SceneManager unload order drift")
ts_reload = section(game, "private async reloadScene", "private applyNpcRuntimeFieldNow")
gd_reload = section(bootstrap, "func _reload_scene", "func set_player_nav_target")
require(ordered_tokens(ts_reload, ["this.sceneManager.unloadScene()", "await this.sceneManager.loadScene(sceneId)", "this.stateController.setState(GameState.Exploring)"]), "TypeScript Game.reloadScene architecture drift")
require(ordered_tokens(gd_reload, ["scene_manager.unload_scene()", "await scene_manager.load_scene(scene_id)", "state_controller.set_state(RuntimeDataTypes.EXPLORING)"]), "Godot Game._reload_scene architecture/order drift")
gd_saved_reload = section(bootstrap, "func reload_saved_scene", "func _process")
require(ordered_tokens(gd_saved_reload, ["zone_system.clear_active_zones_for_restore()", "await _reload_scene(scene_id)"]), "Godot save reload does not preserve clear-active-zones -> Game.reloadScene topology")

ts_scene_ready_handler = section(game, "private setupSceneReadyHandler(): void", "private attachNpcSceneFilters(")
require(ordered_tokens(ts_scene_ready_handler, [
    "this.listenEvent('scene:beforeUnload'", "this.patrolGeneration++", "this.npcPatrolEpoch.clear()",
    "this.sceneManager.getCurrentHotspots()", "h.detachDepthOcclusionFilter()",
    "this.sceneDepthSystem.removeFilter(f)", "f.destroy()",
    "this.listenEvent('scene:ready'", "this.player.syncMovementFromScene",
    "this.interactionSystem.update(0)", "this.sceneDepthSystem.isLightingEnabled",
    "this.sceneDepthSystem.createLightingFilterForEntity", "this.sceneManager.getCurrentNpcs()",
    "this.attachNpcSceneFilters(npc)", "this.startNpcPatrolIfEligible(npc)",
    "this.sceneManager.getCurrentHotspots()", "this.attachHotspotDepthFilter(h)",
    "this.rebuildEntityShadows()", "this.applyShadowAndAO()", "this.syncEntityPixelDensityMatch()",
    "this.depthDebugVisualizer.onSceneLoaded", "'scene:entitiesRebuilt'",
]), "TypeScript Game.setupSceneReadyHandler lifecycle/order drift")

gd_setup_scene_ready = gd_function(bootstrap, "setup_scene_ready_handler")
require(ordered_tokens(gd_setup_scene_ready, [
    'listen_event("scene:beforeUnload"', 'listen_event("scene:ready"',
    'listen_event("scene:entitiesRebuilt"',
]), "Godot Game.setup_scene_ready_handler listener order drift")
require(re.search(r"^\s+setup_scene_ready_handler\(\)\s*$", bootstrap, flags=re.MULTILINE) is not None, "Godot Game startup does not call setup_scene_ready_handler")

gd_before_unload = gd_function(bootstrap, "_on_scene_before_unload_runtime_sync")
require(ordered_tokens(gd_before_unload, [
    "patrol_generation += 1", "npc_patrol_epoch.clear()", "scene_manager.get_current_hotspots()",
    "detach_depth_occlusion_filter()", "scene_depth_system.remove_filter(", ".destroy()",
]), "Godot scene:beforeUnload patrol/filter cleanup order drift")

scene_ready_body = gd_function(bootstrap, "_on_scene_ready_runtime_sync")
require(ordered_tokens(scene_ready_body, [
    "player.sync_movement_from_scene", "interaction_system.update(0.0)",
    "scene_depth_system.is_lighting_enabled", "scene_depth_system.create_lighting_filter_for_entity",
    "RuntimeSceneEntityFilterBinding.attach", "scene_manager.get_current_npcs()",
    "attach_npc_scene_filters(", "_start_npc_patrol_if_eligible(",
    "scene_manager.get_current_hotspots()", "attach_hotspot_depth_filter(",
    "rebuild_entity_shadows()", "apply_shadow_and_ao()", "_sync_entity_pixel_density_match()",
    "depth_debug_visualizer.on_scene_loaded",
]), "Godot scene:ready assembly/order drift")
require("_update_scene_depth_runtime" not in scene_ready_body, "Godot scene:ready runs a target-only whole depth tick instead of source ready assembly")

gd_attach_npc_filters = gd_function(bootstrap, "attach_npc_scene_filters")
require(ordered_tokens(gd_attach_npc_filters, [
    'npc.def.get("renderRaw")', "scene_depth_system.is_lighting_enabled",
    "scene_depth_system.create_lighting_filter_for_entity", "scene_depth_system.create_filter_for_entity",
    "RuntimeSceneEntityFilterBinding.attach",
]), "Godot attach_npc_scene_filters architecture/order drift")
gd_attach_hotspot_filter = gd_function(bootstrap, "attach_hotspot_depth_filter")
require(ordered_tokens(gd_attach_hotspot_filter, [
    "hotspot.has_depth_display_image()", "scene_depth_system.create_filter_for_entity()",
    "hotspot.attach_depth_occlusion_filter(",
]), "Godot attach_hotspot_depth_filter architecture/order drift")

gd_entities_rebuilt = gd_function(bootstrap, "_on_scene_entities_rebuilt_runtime_sync")
ts_entities_rebuilt = section(ts_scene_ready_handler, "'scene:entitiesRebuilt'", "private attachNpcSceneFilters(")
require("this.rebuildEntityShadowsForIds(p.npcIds ?? [], p.hotspotIds ?? [])" in ts_entities_rebuilt, "TypeScript scene:entitiesRebuilt no longer uses the payload-targeted shadow rebuild")
require("this.rebuildEntityShadows();" not in ts_entities_rebuilt, "TypeScript scene:entitiesRebuilt regressed to a full shadow rebuild")
require(ordered_tokens(gd_entities_rebuilt, [
    'payload.get("npcIds"', "scene_manager.get_npc_by_id(", "stop_npc_patrol(",
    "attach_npc_scene_filters(", 'payload.get("hotspotIds"', "scene_manager.get_current_hotspots()",
    "attach_hotspot_depth_filter(", "rebuild_entity_shadows_for_ids(",
]), "Godot scene:entitiesRebuilt does not reattach filters to the payload-targeted NPC/hotspot instances")
require("scene_manager.get_current_npcs()" not in gd_entities_rebuilt, "Godot scene:entitiesRebuilt reattaches NPC filters through an all-scene pass instead of payload ids")
require("rebuild_entity_shadows()" not in gd_entities_rebuilt, "Godot scene:entitiesRebuilt performs a full shadow rebuild instead of the source payload-targeted rebuild")

gd_density_sync = gd_function(bootstrap, "_sync_entity_pixel_density_match")
require(ordered_tokens(gd_density_sync, [
    "scene_manager.get_background_texels_per_world()", "_get_entity_pixel_density_match_effective()",
    "_get_entity_pixel_density_match_blur_scale()", "sync_sprite_entity_pixel_density_match(player.sprite.container",
    "scene_manager.get_current_npcs()", "sync_sprite_entity_pixel_density_match(npc.container",
    "scene_manager.get_current_hotspots()", "hotspot.apply_entity_pixel_density_match(",
]), "Godot sync_entity_pixel_density_match lost source entity order across the single-material engine boundary")
require(all(token not in gd_density_sync for token in [
    "_update_scene_depth_runtime", "update_per_frame", "update_entity_depth_occlusion",
    "update_light_env_from_curve", "update_entity_shadows", "rebuild_entity_shadows",
    "create_filter_for_entity",
]), "Godot sync_entity_pixel_density_match still triggers depth/light/shadow work")

ts_tick = section(game, "private tick(dt: number): void", "\n  }\n}")
gd_tick = section(bootstrap, "func tick", "func _run_pressure_hold_segment")
require("RuntimeMicrotaskQueueScript.flush_one_at_tick_boundary()" in gd_tick, "Godot Game tick does not host the JavaScript microtask checkpoint adapter")
tick_markers = {
    "Exploring": (
        ("if (this.stateController.currentState === GameState.Exploring)", "if (this.stateController.currentState === GameState.Cutscene)"),
        ("RuntimeDataTypes.EXPLORING:", "RuntimeDataTypes.CUTSCENE:"),
        ["this.updatePlayerNav()", "this.player.update(dt)", "wasKeyJustPressed('KeyQ')", "this.interactionSystem.update(dt)", "this.zoneSystem.update(dt)", "this.sceneManager.getCurrentNpcs()", "this.camera.follow"],
        ["_update_player_nav()", "player.update(dt)", 'was_key_just_pressed("KeyQ")', "interaction_system.update(dt)", "zone_system.update(dt)", "_update_scene_npcs_and_patrol(dt)", "camera.follow"],
    ),
    "Cutscene": (
        ("if (this.stateController.currentState === GameState.Cutscene)", "if (this.stateController.currentState === GameState.Dialogue)"),
        ("RuntimeDataTypes.CUTSCENE:", "RuntimeDataTypes.DIALOGUE:"),
        ["this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()", "this.cutsceneManager.getTempActors()"],
        ["player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)", "cutscene_manager.get_temp_actors()"],
    ),
    "Dialogue": (
        ("if (this.stateController.currentState === GameState.Dialogue)", "if (this.stateController.currentState === GameState.Encounter)"),
        ("RuntimeDataTypes.DIALOGUE:", "RuntimeDataTypes.ENCOUNTER:"),
        ["this.dialogueUI.update(dt)", "this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()"],
        ["dialogue_ui.update(dt)", "player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)"],
    ),
    "Encounter": (
        ("if (this.stateController.currentState === GameState.Encounter)", "if (this.stateController.currentState === GameState.Minigame)"),
        ("RuntimeDataTypes.ENCOUNTER:", "RuntimeDataTypes.MINIGAME:"),
        ["this.encounterUI.update(dt)", "this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()"],
        ["encounter_ui.update(dt)", "player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)"],
    ),
    "Minigame": (
        ("if (this.stateController.currentState === GameState.Minigame)", "if (this.stateController.currentState === GameState.UIOverlay)"),
        ("RuntimeDataTypes.MINIGAME:", "RuntimeDataTypes.UI_OVERLAY:"),
        ["this.waterMinigameManager.update(dt)", "this.sugarWheelMinigameManager.update(dt)", "this.paperCraftMinigameManager.update(dt)", "this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()"],
        ["water_minigame_manager.update(dt)", "sugar_wheel_minigame_manager.update(dt)", "paper_craft_minigame_manager.update(dt)", "player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)"],
    ),
    "UIOverlay": (
        ("if (this.stateController.currentState === GameState.UIOverlay)", "if (this.stateController.currentState === GameState.ActionSequence)"),
        ("RuntimeDataTypes.UI_OVERLAY:", "RuntimeDataTypes.ACTION_SEQUENCE:"),
        ["this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()"],
        ["player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)"],
    ),
    "ActionSequence": (
        ("if (this.stateController.currentState === GameState.ActionSequence)", "this.emoteBubbleManager.update(dt)"),
        ("RuntimeDataTypes.ACTION_SEQUENCE:", "if emote_bubble_manager"),
        ["this.player.cutsceneUpdate(dt)", "this.sceneManager.getCurrentNpcs()", "this.camera.follow"],
        ["player.cutscene_update(dt)", "_update_scene_npcs_and_patrol(dt)", "camera.follow"],
    ),
}
for state, (ts_bounds, gd_bounds, ts_tokens, gd_tokens) in tick_markers.items():
    expected_count = len(CONTRACT["logicTickOrder"][state])
    require(len(ts_tokens) == expected_count and len(gd_tokens) == expected_count, f"{state} tick contract mapping count drift")
    require(ordered_tokens(section(ts_tick, *ts_bounds), ts_tokens), f"TypeScript {state} logic tick order drift")
    require(ordered_tokens(section(gd_tick, *gd_bounds), gd_tokens), f"Godot {state} logic tick order drift")
require(ordered_tokens(ts_tick, [
    "this.planeReconciler.update(dt)", "this.emoteBubbleManager.update(dt)", "this.notificationUI.update(dt)",
    "this.camera.update(dt)", "this.debugTools?.update(dt)", "this.depthDebugVisualizer?.update()",
    "this.syncEntityPixelDensityMatch()", "if (this.sceneDepthSystem.isActive)",
    "this.sceneDepthSystem.updatePerFrame(", "this.updateLightEnvFromCurve()", "this.updateEntityShadows()",
]), "TypeScript common logic/debug/density/depth/light/shadow tick order drift")
require(ordered_tokens(gd_tick, [
    "plane_reconciler.update(dt)", "emote_bubble_manager.update(dt)", "notification_ui.update(dt)",
    "camera.update(dt)", "debug_tools.update(dt)", "depth_debug_visualizer.update()",
    "_sync_entity_pixel_density_match()", "if scene_depth_system.is_active", "_update_scene_depth_runtime()",
    "update_light_env_from_curve()", "update_entity_shadows()",
]), "Godot common logic/debug/density/depth/light/shadow tick order drift")

ts_panel_block = section(game, "private registerUIPanels()", "private guardMapTravel")
if not ts_panel_block:
    ts_panel_block = section(game, "private registerUIPanels()", "private async startDevMode")
ts_panels = re.findall(r"registerPanel\('([^']+)'", ts_panel_block)
gd_panel_block = section(bootstrap, "func _register_ui_panels", "func _build_runtime_command_dependencies")
gd_panels = re.findall(r'register_panel\("([^"]+)"', gd_panel_block)
require(ts_panels == CONTRACT["registeredPanels"], f"TypeScript panel registration order drift: {ts_panels}")
require(gd_panels == CONTRACT["registeredPanels"], f"Godot panel registration order drift: {gd_panels}")
require('register_panel("devMode"' not in bootstrap, "Godot must not put the separately-owned DevModeUI into GameStateController")
require("shop_ui.destroy()" not in section(bootstrap, "func destroy", "func _exit_tree"), "bootstrap must let GameStateController own registered ShopUI destruction")
require("cutscene_renderer.destroy()" not in cutscene_manager, "CutsceneManager must not destroy the separately-owned CutsceneRenderer")
destroy_body = section(bootstrap, "func destroy", "func _exit_tree")
require(ordered_tokens(destroy_body, [
    "interaction_coordinator.destroy()", "event_bridge.destroy()", "debug_tools.destroy()",
    "depth_debug_visualizer.destroy()", "state_controller.destroy()",
    "touch_mobile_controls.destroy()", "entry.system.destroy()", "event_bus.clear()",
    "runtime_root.release_system_nodes()", "cutscene_renderer.destroy()",
    "action_executor.destroy()", "flag_store.destroy()", "input_manager.destroy()",
    "renderer.destroy()", "asset_manager.dispose()",
]), "Godot teardown ownership/order drift")
require(ordered_tokens(section(bootstrap, "func _exit_tree", "__EOF__"), ["func _exit_tree", "destroy()"]), "Godot _exit_tree adapter must delegate to source-shaped Game.destroy")

condition_body = gd_function(bootstrap, "build_condition_eval_context")
condition_fields = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', condition_body, flags=re.MULTILINE)
require(set(condition_fields) == set(CONTRACT["conditionContextFields"]), f"ConditionEvalContext fields drift: {condition_fields}")
require("evaluateList" not in bootstrap and "evaluateList" not in read("godot_port/scripts" + "/runtime/flag_store.gd"), "condition consumers still depend on an ad-hoc evaluateList callback")
for path in [
    "godot_port/scripts/runtime/flag_store.gd",
    "godot_port/scripts/systems/archive_manager.gd",
    "godot_port/scripts/systems/narrative_state_manager.gd",
    "godot_port/scripts/systems/zone_system.gd",
    "godot_port/scripts/systems/inventory_manager.gd",
    "godot_port/scripts/systems/quest_manager.gd",
]:
    require("RuntimeConditionEvalBridgeScript" in read(path), f"condition consumer bypasses RuntimeConditionEvalBridge: {path}")

interaction_wiring = section(bootstrap, "RuntimeInteractionCoordinator.new", "interaction_coordinator.init()")
interaction_keys = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', interaction_wiring, flags=re.MULTILINE)
require(interaction_keys == CONTRACT["interactionDependencies"], f"InteractionCoordinator dependencies drift: {interaction_keys}")
require(not re.search(r"^var (?:player|camera):", interaction, flags=re.MULTILINE), "InteractionCoordinator directly owns Player/Camera instead of injected callbacks")
require("camera.set_zoom" not in interaction, "InteractionCoordinator bypasses CutsceneManager camera tween")

require(ordered_tokens(game_start, [
    "_register_ui_panels()", "interaction_coordinator.init()", "event_bridge.init()", "debug_tools.init()",
    'await setup_player({"deferAvatar": is_dev_mode})', "if is_dev_mode:", "await start_dev_mode(",
    "else:", "await scene_manager.load_initial_scene(initial_scene)", "_try_start_initial_prologue",
    "setup_runtime_command_polling()",
]), "Godot initial scene consumers/player/dev-normal branch/prologue/runtime-command order drifted")
require("map_ui.set_current_scene(scene_manager.get_current_scene_id())" not in bootstrap, "bootstrap manually repairs initial map state instead of routing scene:enter through EventBridge")

require(ordered_tokens(ts_inventory_manager, [
    "private eventBus", "private flagStore", "private itemDefs", "private slots", "private coins",
    "private loaded", "private strings", "private assetManager", "private conditionCtxFactory", "constructor(",
    "init(ctx", "setConditionEvalContextFactory(", "update(_dt", "async loadDefs()", "for (const def of defs)",
    "this.itemDefs.set(def.id, def)", "this.loaded = true", "getItemDef(", "private getUsedSlots(",
    "addItem(", "removeItem(", "hasItem(", "getItemCount(", "getAllItems(", "getCoins(", "addCoins(",
    "removeCoins(", "getItemDescription(", "canDiscard(", "discardItem(", "private syncItemFlags(",
    "serialize()", "deserialize(", "destroy()",
]), "TypeScript InventoryManager field/method architecture drift")
inventory_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_inventory_manager, flags=re.MULTILINE)
inventory_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_inventory_manager, flags=re.MULTILINE)
require(inventory_fields == [
    "event_bus", "flag_store", "item_defs", "slots", "coins", "loaded", "strings", "asset_manager",
    "condition_ctx_factory",
], f"Godot InventoryManager field architecture/order drift: {inventory_fields}")
require(inventory_methods == [
    "_init", "init", "set_condition_eval_context_factory", "update", "load_defs", "get_item_def",
    "_get_used_slots", "add_item", "remove_item", "has_item", "get_item_count", "get_all_items",
    "get_coins", "add_coins", "remove_coins", "get_item_description", "can_discard", "discard_item",
    "_sync_item_flags", "serialize", "deserialize", "destroy",
], f"Godot InventoryManager method architecture/order drift: {inventory_methods}")
inventory_load = gd_function(gd_inventory_manager, "load_defs")
inventory_get_all = gd_function(gd_inventory_manager, "get_all_items")
inventory_add_coins = gd_function(gd_inventory_manager, "add_coins")
inventory_serialize = gd_function(gd_inventory_manager, "serialize")
inventory_destroy = gd_function(gd_inventory_manager, "destroy")
require("item_defs.clear()" not in inventory_load and "item_defs[definition.get(\"id\")] = definition" in inventory_load
        and inventory_load.count("loaded = true") == 3,
        "Godot InventoryManager loadDefs Map/reference/loaded semantics drift")
require('\"def\": item_defs.get(id)' in inventory_get_all,
        "Godot InventoryManager getAllItems omits the source def:undefined field shape")
require("-> void" in inventory_add_coins and "push_warning(\"InventoryManager.addCoins:" in inventory_add_coins
        and "return true" not in inventory_add_coins and "return false" not in inventory_add_coins,
        "Godot InventoryManager addCoins return/warning contract drift")
require("duplicate(" not in inventory_serialize and "var items := {}" in inventory_serialize,
        "Godot InventoryManager serialize no longer constructs the source-owned item record")
require(ordered_tokens(inventory_destroy, ["slots.clear()", "item_defs.clear()", "coins = 0.0"])
        and "loaded" not in inventory_destroy and "condition_ctx_factory" not in inventory_destroy
        and "asset_manager" not in inventory_destroy,
        "Godot InventoryManager destroy ownership drift")
for forbidden_inventory_api in ["get_item_name_map", "debug_snapshot_fragment", "definition_count"]:
    require(forbidden_inventory_api not in gd_inventory_manager,
            f"Godot InventoryManager retains target-only API: {forbidden_inventory_api}")
require("await inventory_manager.load_defs()" in gd_startup_load_phase
        and "if not inventory_manager.load_defs()" not in gd_startup_load_phase,
        "Godot Game still treats source InventoryManager.loadDefs Promise<void> as a boolean loader")

require(ordered_tokens(ts_rules_manager, [
    "const LAYER_ORDER", "function normalizeRuleDef(", "function normalizeFragmentDef(", "export class RulesManager",
    "private eventBus", "private flagStore", "private ruleDefs", "private fragmentDefs", "private categoryNames",
    "private verifiedLabels", "private acquiredFragments", "private grantedLayers", "constructor(", "private strings",
    "private assetManager", "init(ctx", "update(_dt", "private static definedLayers(", "private layerDoneFlagKey(",
    "private snapshotLayerDone(", "private hasLayerImpl(", "private hasRuleInternal(", "async loadDefs()",
    "private emitRuleAcquired(", "giveRule(", "grantLayer(", "giveFragment(", "private syncRuleFlags(",
    "private resyncAllRuleFlags(", "private tryAutoSynthesize(", "hasRule(", "hasLayer(", "hasFragment(",
    "getRuleDef(", "getCategoryName(", "getVerifiedLabel(", "isDiscovered(", "getDiscoveredRules(",
    "getAcquiredRules(", "getFragmentProgress(", "getRuleDepth(", "getUnlockedLayerTexts(",
    "getLayerFragmentProgress(", "getPendingFragments(", "serialize()", "deserialize(", "destroy()",
]), "TypeScript RulesManager module/field/method architecture drift")
rules_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_rules_manager, flags=re.MULTILINE)
rules_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_rules_manager, flags=re.MULTILINE)
require(rules_fields == [
    "event_bus", "flag_store", "rule_defs", "fragment_defs", "category_names", "verified_labels",
    "acquired_fragments", "granted_layers", "strings", "asset_manager",
], f"Godot RulesManager field architecture/order drift: {rules_fields}")
require(rules_methods == [
    "normalize_rule_def", "normalize_fragment_def", "_init", "init", "update", "_defined_layers",
    "_layer_done_flag_key", "_snapshot_layer_done", "_has_layer_impl", "_has_rule_internal", "load_defs",
    "_emit_rule_acquired", "give_rule", "grant_layer", "give_fragment", "_sync_rule_flags",
    "_resync_all_rule_flags", "_try_auto_synthesize", "has_rule", "has_layer", "has_fragment",
    "get_rule_def", "get_category_name", "get_verified_label", "is_discovered", "get_discovered_rules",
    "get_acquired_rules", "get_fragment_progress", "get_rule_depth", "get_unlocked_layer_texts",
    "get_layer_fragment_progress", "get_pending_fragments", "serialize", "deserialize", "destroy",
], f"Godot RulesManager method architecture/order drift: {rules_methods}")
rules_normalize = gd_function(gd_rules_manager, "normalize_rule_def")
rules_load = gd_function(gd_rules_manager, "load_defs")
rules_give_fragment = gd_function(gd_rules_manager, "give_fragment")
rules_deserialize = gd_function(gd_rules_manager, "deserialize")
rules_destroy = gd_function(gd_rules_manager, "destroy")
require("duplicate(true)" not in gd_rules_manager and "return definition" in rules_normalize
        and "definition.duplicate(false)" in rules_normalize and "layer_definition.duplicate(false)" in rules_normalize,
        "Godot RulesManager normalization no longer preserves source reference/shallow-copy semantics")
require(ordered_tokens(rules_load, [
    "rule_defs.clear()", "fragment_defs.clear()", "normalize_rule_def(raw)",
    "normalize_fragment_def(raw)", "category_names = categories", "verified_labels = labels",
]) and "-> void" in rules_load,
        "Godot RulesManager loadDefs clear/normalize/metadata/return contract drift")
require('push_warning("RulesManager: unknown fragment' in rules_give_fragment,
        "Godot RulesManager giveFragment lost the source unknown-fragment warning")
require(ordered_tokens(rules_deserialize, [
    "acquired_fragments = {}", "granted_layers = {}", "legacy_rules", "_resync_all_rule_flags()",
]), "Godot RulesManager deserialize no longer replaces source Set/Map instances")
require(ordered_tokens(rules_destroy, [
    "acquired_fragments.clear()", "granted_layers.clear()", "rule_defs.clear()", "fragment_defs.clear()",
]) and "category_names" not in rules_destroy and "verified_labels" not in rules_destroy,
        "Godot RulesManager destroy ownership drift")
require("definition_counts" not in gd_rules_manager, "Godot RulesManager retains target-only definitionCounts API")
require("await rules_manager.load_defs()" in gd_startup_load_phase
        and "if not rules_manager.load_defs()" not in gd_startup_load_phase,
        "Godot Game still treats source RulesManager.loadDefs Promise<void> as a boolean loader")

require(ordered_tokens(ts_quest_manager, [
    "private eventBus", "private flagStore", "private actionExecutor", "private conditionCtxFactory",
    "private questDefs", "private questStatus", "private evaluating", "private pendingEvaluate", "private strings",
    "private assetManager", "private onFlagChanged", "private questActionTail", "private restoring", "constructor(",
    "this.onFlagChanged =", "setRestoring(", "setConditionEvalContextFactory(", "private evalConditions(",
    "init(ctx", "update(_dt", "async loadDefs()", "private enqueueQuestActions(", "acceptQuest(",
    "private completeQuest(", "private evaluate(", "getStatus(", "debugSetQuestStatus(", "getQuestTitle(",
    "getActiveQuests(", "getCompletedQuests(", "getCurrentMainQuest(", "private syncFlag(",
    "private normalizeQuestStatus(", "serialize()", "deserialize(", "destroy()",
]), "TypeScript QuestManager field/method architecture drift")
quest_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_quest_manager, flags=re.MULTILINE)
quest_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_quest_manager, flags=re.MULTILINE)
require(quest_fields == [
    "event_bus", "flag_store", "action_executor", "condition_ctx_factory", "quest_defs", "quest_status",
    "evaluating", "pending_evaluate", "strings", "asset_manager", "on_flag_changed", "quest_action_tail", "restoring",
], f"Godot QuestManager field architecture/order drift: {quest_fields}")
require(quest_methods == [
    "_init", "set_restoring", "set_condition_eval_context_factory", "_eval_conditions", "init", "update",
    "load_defs", "_enqueue_quest_actions", "accept_quest", "_complete_quest", "_evaluate", "get_status",
    "debug_set_quest_status", "get_quest_title", "get_active_quests", "get_completed_quests",
    "get_current_main_quest", "_sync_flag", "_normalize_quest_status", "serialize", "deserialize", "destroy",
], f"Godot QuestManager method architecture/order drift: {quest_methods}")
quest_load = gd_function(gd_quest_manager, "load_defs")
quest_enqueue = gd_function(gd_quest_manager, "_enqueue_quest_actions")
quest_accept = gd_function(gd_quest_manager, "accept_quest")
quest_complete = gd_function(gd_quest_manager, "_complete_quest")
quest_deserialize = gd_function(gd_quest_manager, "deserialize")
quest_normalize = gd_function(gd_quest_manager, "_normalize_quest_status")
quest_destroy = gd_function(gd_quest_manager, "destroy")
require("quest_defs.clear()" not in quest_load and "duplicate(" not in quest_load
        and "quest_defs[id] = definition" in quest_load and "-> void" in quest_load,
        "Godot QuestManager loadDefs Map/reference/return contract drift")
require("RuntimeAsyncTail" in gd_quest_manager and "var tail := quest_action_tail" in quest_enqueue
        and "RuntimeMicrotaskQueueScript.queue_microtask" in quest_enqueue,
        "Godot QuestManager questActionTail no longer translates the source Promise tail")
require('push_warning("QuestManager: acceptActions failed")' in quest_accept
        and 'push_warning("QuestManager: rewards failed")' in quest_complete,
        "Godot QuestManager lost source inner action failure boundaries")
require("for raw_id: Variant in data:" in quest_deserialize and "quest_status[id] = data[raw_id]" in quest_deserialize
        and "sort" not in quest_deserialize and "int(data" not in quest_deserialize,
        "Godot QuestManager deserialize changes source insertion order or raw status values")
require(ordered_tokens(quest_normalize, [
    "var untrimmed_text", 'untrimmed_text == "completed"', "var text := str(status).strip_edges().to_lower()",
    'text == "active"', 'text == "accepted"',
]), "Godot QuestManager normalizeQuestStatus trim asymmetry drift")
require(ordered_tokens(quest_destroy, [
    'event_bus.off("flag:changed", on_flag_changed)',
    'event_bus.off("narrative:stateChanged", on_flag_changed)',
    "quest_defs.clear()", "quest_status.clear()", "quest_action_tail = RuntimeAsyncTail.new()",
]) and "condition_ctx_factory" not in quest_destroy and "restoring" not in quest_destroy,
        "Godot QuestManager destroy ownership drift")
for forbidden_quest_api in [
    "quest_order", "load_defs_from_data", "definition_count", "debug_snapshot_fragment", "action_queue",
    "_drain_action_queue", "_ordered_data_ids", "_ordered_status_ids", "_destroyed",
]:
    require(forbidden_quest_api not in gd_quest_manager,
            f"Godot QuestManager retains target-only API/state: {forbidden_quest_api}")
require("await quest_manager.load_defs()" in gd_startup_load_phase
        and "if not quest_manager.load_defs()" not in gd_startup_load_phase,
        "Godot Game still treats source QuestManager.loadDefs Promise<void> as a boolean loader")

require(ordered_tokens(ts_encounter_manager, [
    "private eventBus", "private flagStore", "private actionExecutor", "private conditionCtxFactory",
    "private encounterDefs", "private currentEncounter", "private currentOptions", "private active", "private resolving",
    "private ruleNameResolver", "private resolveDisplay", "constructor(", "private strings", "private assetManager",
    "init(ctx", "update(_dt", "setConditionEvalContextFactory(", "private evalConditions(",
    "setRuleNameResolver(", "setResolveDisplay(", "private r(", "private layerLabel(", "async loadDefs()",
    "hasEncounter(", "startEncounter(", "generateOptions(", "async chooseOption(", "endEncounter(",
    "get isActive", "serialize()", "deserialize(", "destroy()",
]), "TypeScript EncounterManager field/method architecture drift")
encounter_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_encounter_manager, flags=re.MULTILINE)
encounter_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_encounter_manager, flags=re.MULTILINE)
require(encounter_fields == [
    "event_bus", "flag_store", "action_executor", "condition_ctx_factory", "encounter_defs", "current_encounter",
    "current_options", "active", "resolving", "rule_name_resolver", "resolve_display", "strings", "asset_manager",
], f"Godot EncounterManager field architecture/order drift: {encounter_fields}")
require(encounter_methods == [
    "_init", "init", "update", "set_condition_eval_context_factory", "_eval_conditions",
    "set_rule_name_resolver", "set_resolve_display", "_r", "_layer_label", "load_defs", "has_encounter",
    "start_encounter", "generate_options", "choose_option", "end_encounter", "is_active", "serialize",
    "deserialize", "destroy",
], f"Godot EncounterManager method architecture/order drift: {encounter_methods}")
encounter_load = gd_function(gd_encounter_manager, "load_defs")
encounter_start = gd_function(gd_encounter_manager, "start_encounter")
encounter_generate = gd_function(gd_encounter_manager, "generate_options")
encounter_choose = gd_function(gd_encounter_manager, "choose_option")
encounter_end = gd_function(gd_encounter_manager, "end_encounter")
encounter_destroy = gd_function(gd_encounter_manager, "destroy")
require("encounter_defs.clear()" not in encounter_load and "duplicate(" not in encounter_load
        and "encounter_defs[definition.get(\"id\")] = definition" in encounter_load and "-> void" in encounter_load,
        "Godot EncounterManager loadDefs Map/reference/return contract drift")
require("current_options" not in encounter_start and "resolving" not in encounter_start
        and "strip_edges" not in encounter_start and "-> void" in encounter_start,
        "Godot EncounterManager startEncounter invents resets/id normalization/return value")
require('event_bus.emit("encounter:options", {"options": current_options})' in encounter_generate
        and "duplicate(" not in encounter_generate and "push_error(" in encounter_generate,
        "Godot EncounterManager generateOptions copy/error/event identity drift")
require(ordered_tokens(encounter_choose, [
    "if resolving or not active:", "resolving = true", "current_options = []",
    "await action_executor.execute_await", "await action_executor.execute_batch_await",
    'push_warning("EncounterManager: resultActions failed")', "resolving = false",
]), "Godot EncounterManager chooseOption guard/action/finally order drift")
require("resolving" not in encounter_end and "resolving" not in encounter_destroy
        and "condition_ctx_factory" not in encounter_destroy and "rule_name_resolver" not in encounter_destroy
        and "resolve_display" not in encounter_destroy,
        "Godot EncounterManager end/destroy invents source-absent resets")
for forbidden_encounter_api in ["RULE_LAYERS", "is_resolving", "get_current_options", "_resolved_option"]:
    require(forbidden_encounter_api not in gd_encounter_manager,
            f"Godot EncounterManager retains target-only API/state: {forbidden_encounter_api}")
encounter_choice_bridge = section(gd_bridge, '_listen("encounter:choiceSelected"', '_listen("encounter:resultDone"')
require("await encounter_manager.choose_option" in encounter_choice_bridge
        and 'push_warning("EventBridge: encounter chooseOption failed")' in encounter_choice_bridge,
        "Godot EventBridge encounter choice lost source rejected-Promise warning boundary")
require("await encounter_manager.load_defs()" in gd_startup_load_phase
        and "if not encounter_manager.load_defs()" not in gd_startup_load_phase,
        "Godot Game still treats source EncounterManager.loadDefs Promise<void> as a boolean loader")

require(ordered_tokens(ts_plane_reconciler, [
    "private readonly eventBus", "private assetManager", "private binding", "private defs",
    "private manualOverridePlaneId", "private manualOverrideScope", "private inCutscene", "private lastNaming",
    "private activePlaneId", "private cameraApplied", "private drainAccum", "private lastGameState",
    "private warnedUnknownPlaneIds", "private pendingZoneRefresh", "private readonly onNarrativeStateChanged",
    "private readonly onSceneReady", "private readonly onEntitiesRebuilt", "private readonly onSaveRestoring",
    "private readonly onCutsceneStart", "private readonly onCutsceneEnd", "constructor(", "init(ctx",
    "bindRuntime(", "async loadDefs()", "registerDefs(", "private static readonly INHERITED_SLOT_KEYS",
    "private static findExtendsCycleMembers(", "private expandExtends(", "update(dt",
    "getActivePlaneId(", "getActivePlaneMembership(", "isMapTravelAllowed(", "getActiveCameraZoom(",
    "activatePlaneManually(", "deactivateManualPlane(", "getDebugState(", "serialize()", "deserialize(",
    "destroy()", "private statePlaneOf(", "private noteGraphState(", "private recomputeNamingFromNarrative(",
    "private recomputeActivePlaneId(", "private recomputeActiveAndReconcileIfChanged(", "private activeDef(",
    "private reconcile(", "private applyMovementSlot(", "private applyInteractionSlot(",
    "private applyCameraSlot(", "private applyLightingSlot(", "private validateDef(",
]), "TypeScript PlaneReconciler field/method architecture drift")
plane_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_plane_reconciler, flags=re.MULTILINE)
plane_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_plane_reconciler, flags=re.MULTILINE)
require(plane_fields == [
    "event_bus", "asset_manager", "binding", "defs", "manual_override_plane_id", "manual_override_scope",
    "in_cutscene", "last_naming", "active_plane_id", "camera_applied", "drain_accum", "last_game_state",
    "warned_unknown_plane_ids", "pending_zone_refresh", "on_narrative_state_changed", "on_scene_ready",
    "on_entities_rebuilt", "on_save_restoring", "on_cutscene_start", "on_cutscene_end",
], f"Godot PlaneReconciler field architecture/order drift: {plane_fields}")
require(plane_methods == [
    "_init", "init", "bind_runtime", "load_defs", "register_defs", "_find_extends_cycle_members",
    "_expand_extends", "update", "get_active_plane_id", "get_active_plane_membership",
    "is_map_travel_allowed", "get_active_camera_zoom", "activate_plane_manually", "deactivate_manual_plane",
    "get_debug_state", "serialize", "deserialize", "destroy", "_state_plane_of", "_note_graph_state",
    "_recompute_naming_from_narrative", "_recompute_active_plane_id",
    "_recompute_active_and_reconcile_if_changed", "_active_def", "_reconcile", "_apply_movement_slot",
    "_apply_interaction_slot", "_apply_camera_slot", "_apply_lighting_slot", "_validate_def",
], f"Godot PlaneReconciler method architecture/order drift: {plane_methods}")
plane_constructor = gd_function(gd_plane_reconciler, "_init")
plane_init = gd_function(gd_plane_reconciler, "init")
require(ordered_tokens(plane_constructor, [
    "event_bus = next_event_bus", "on_narrative_state_changed = func", "_note_graph_state(",
    "_recompute_active_and_reconcile_if_changed()", "on_scene_ready = func", "_recompute_naming_from_narrative()",
    "_recompute_active_plane_id()", "_reconcile()", "on_entities_rebuilt = func",
    "refreshEntitiesForPlaneChange", "on_save_restoring = func", "manual_override_plane_id = null",
    "on_cutscene_start = func", "in_cutscene = true", "on_cutscene_end = func", "in_cutscene = false",
    'manual_override_scope == "cutscene"', "_recompute_active_and_reconcile_if_changed()",
]), "Godot PlaneReconciler constructor-bound callback architecture/order drift")
plane_listener_events = [
    "narrative:stateChanged", "scene:ready", "scene:entitiesRebuilt",
    "save:restoring", "cutscene:start", "cutscene:end",
]
require([event for event in plane_listener_events if f'event_bus.off("{event}"' in plane_init] == plane_listener_events
        and [event for event in plane_listener_events if f'event_bus.on("{event}"' in plane_init] == plane_listener_events
        and plane_init.find('event_bus.off("cutscene:end"') < plane_init.find('event_bus.on("narrative:stateChanged"'),
        "Godot PlaneReconciler init does not preserve six callback identities/off-before-on ordering")
require(ordered_tokens(plane_init, [
    "asset_manager = ctx.assetManager", 'event_bus.off("narrative:stateChanged"',
    'event_bus.off("cutscene:end"', 'event_bus.on("narrative:stateChanged"', 'event_bus.on("cutscene:end"',
    "manual_override_plane_id = null", 'manual_override_scope = "session"', "in_cutscene = false",
    "last_naming.clear()", "active_plane_id = NORMAL_PLANE_ID", "camera_applied = false",
    "drain_accum = 0.0", "last_game_state = null", "warned_unknown_plane_ids.clear()",
    "pending_zone_refresh = false",
]), "Godot PlaneReconciler init state-reset order drift")
plane_load = gd_function(gd_plane_reconciler, "load_defs")
plane_register = gd_function(gd_plane_reconciler, "register_defs")
plane_cycle = gd_function(gd_plane_reconciler, "_find_extends_cycle_members")
plane_expand = gd_function(gd_plane_reconciler, "_expand_extends")
require(ordered_tokens(plane_load, [
    "if asset_manager == null:", "loadDefs 前未 init", "asset_manager.load_json(PLANES_URL)",
    "await RuntimeMicrotaskQueueScript.yield_turn()", "if definitions is Array:", "register_defs(definitions)",
    "asset_manager.get_last_error()", "planes.json not found", "else:", "register_defs([])",
]) and "-> void" in plane_load, "Godot PlaneReconciler loadDefs Promise<void>/fulfill/reject translation drift")
require(ordered_tokens(plane_register, [
    "defs.clear()", "var raw: Dictionary = {}", "for definition: Variant in definitions:",
    "if not _validate_def(definition):", "位面配置", "continue", "raw[definition.id] = definition",
    "var expanded := _expand_extends(raw)", "for id: Variant in expanded:", "defs[id] = expanded[id]",
]) and "strip_edges" not in plane_register and "duplicate(" not in plane_register,
        "Godot PlaneReconciler registerDefs Map/raw-reference/validation semantics drift")
require(ordered_tokens(plane_cycle, [
    "var on_cycle: Dictionary", "var state: Dictionary", "for raw_start: Variant in raw:",
    'state[current] = "visiting"', "path.push_back(current)", "definition.extends.strip_edges()",
    'state.get(current) == "visiting"', "path.find(current)", "on_cycle[path[index]] = true",
    'state[id] = "done"', "return on_cycle",
]), "Godot PlaneReconciler extends-cycle member algorithm/order drift")
require(ordered_tokens(plane_expand, [
    "_find_extends_cycle_members(raw)", "for raw_id: Variant in cycle_members:", "extends 链存在环",
    "var output: Dictionary = {}", 'var resolve_box := {"callable": Callable()}',
    "resolve_box.callable = func", "output.get(id)", "raw.get(id)", "definition.duplicate(false)",
    "not cycle_members.has(id)", "definition.extends.strip_edges()", "trail.has(id)", "trail[id] = true",
    "var recursive_resolve: Callable = resolve_box.callable", "recursive_resolve.call(parent_id, trail)",
    "父位面", "for key: String in INHERITED_SLOT_KEYS:", "if not flat.has(key) and parent.has(key):",
    "flat[key] = parent[key]", "output[id] = flat", "var resolve: Callable = resolve_box.callable",
    "for raw_id: Variant in raw:", "resolve.call(str(raw_id), {})", "resolve = Callable()",
    "resolve_box.callable = Callable()", "return output",
]) and "duplicate(true)" not in plane_expand,
        "Godot PlaneReconciler slot-level shallow extends expansion/local-recursion architecture drift")
plane_update = gd_function(gd_plane_reconciler, "update")
require(ordered_tokens(plane_update, [
    "if not binding is Dictionary:", "binding.getGameState", "if state != last_game_state:",
    "state == RuntimeDataTypes.EXPLORING and last_game_state != null", "last_game_state = state",
    "_apply_camera_slot()", "_apply_lighting_slot()", "if pending_zone_refresh:",
    "pending_zone_refresh = false", "binding.refreshZonesForPlaneChange", "if state != RuntimeDataTypes.EXPLORING:",
    'definition.get("healthDrainPerSec")', "drain_accum += float(drain) * dt", "floor(drain_accum)",
    "drain_accum -= whole", "RuntimePromiseObserverScript.observe(binding.damagePlayer, [whole]",
    "drain_accum = 0.0",
]), "Godot PlaneReconciler game-state edge/drain/fire-and-forget update order drift")
require(re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_promise_observer, flags=re.MULTILINE) == ["observe"]
        and ordered_tokens(gd_promise_observer, [
            "static func observe(", "await callback.callv(args)", "callback = Callable()", "args.clear()",
            "result is bool and result == false", "push_warning(failure_warning)",
        ]), "Godot rejected-Promise observer adapter ownership/order drift")
plane_recompute_naming = gd_function(gd_plane_reconciler, "_recompute_naming_from_narrative")
plane_recompute_active = gd_function(gd_plane_reconciler, "_recompute_active_plane_id")
plane_reconcile = gd_function(gd_plane_reconciler, "_reconcile")
require(ordered_tokens(plane_recompute_naming, [
    "last_naming.clear()", "narrative.get_graphs()", "narrative.get_active_state", "_state_plane_of",
    "named.push_back", "last_naming[graph.id] = plane", "distinct_planes", "distinct_planes.size() > 1",
    "push_error(",
]), "Godot PlaneReconciler full narrative recomputation/ambiguity diagnostic drift")
require(ordered_tokens(plane_recompute_active, [
    "manual_override_plane_id", "for plane_id: Variant in last_naming.values():", "NORMAL_PLANE_ID",
    "not defs.has(resolved)", "not warned_unknown_plane_ids.has(resolved)",
    "warned_unknown_plane_ids[resolved] = true", "push_warning(", "if resolved == active_plane_id:",
    "active_plane_id = resolved", "drain_accum = 0.0", "return true",
]), "Godot PlaneReconciler active-plane precedence/unknown-warning dedupe drift")
require(ordered_tokens(plane_reconcile, [
    "refreshEntitiesForPlaneChange", "getGameState", "RuntimeDataTypes.EXPLORING",
    "pending_zone_refresh = false", "refreshZonesForPlaneChange", "else:", "pending_zone_refresh = true",
    "_apply_movement_slot()", "_apply_interaction_slot()", "_apply_camera_slot()", "_apply_lighting_slot()",
]), "Godot PlaneReconciler entity/zone/slot reconciliation order drift")
plane_destroy = gd_function(gd_plane_reconciler, "destroy")
require(ordered_tokens(plane_destroy, [
    'event_bus.off("narrative:stateChanged"', 'event_bus.off("scene:ready"',
    'event_bus.off("scene:entitiesRebuilt"', 'event_bus.off("save:restoring"',
    'event_bus.off("cutscene:start"', 'event_bus.off("cutscene:end"', "var owned_binding: Variant = binding",
    "set_movement.call(null)", "set_interaction.call(null)", "set_lighting.call(null)",
    "if camera_applied:", "restore_camera.call()", "binding = null", "defs.clear()", "last_naming.clear()",
    "manual_override_plane_id = null", 'manual_override_scope = "session"', "in_cutscene = false",
    "active_plane_id = NORMAL_PLANE_ID", "camera_applied = false", "drain_accum = 0.0",
    "last_game_state = null", "warned_unknown_plane_ids.clear()", "pending_zone_refresh = false",
]), "Godot PlaneReconciler destroy listener/slot/state ownership order drift")
for forbidden_plane_api in [
    "_call_binding", "_finite_number", "definition_count", "debug_snapshot_fragment", "func _on_event(",
    "_find_cycle_members", "_resolve_definition", "load_defs_from_data",
]:
    require(forbidden_plane_api not in gd_plane_reconciler,
            f"Godot PlaneReconciler retains invented/flattened target-only API/state: {forbidden_plane_api}")
require(not re.search(r"^var narrative:", gd_plane_reconciler, flags=re.MULTILINE),
        "Godot PlaneReconciler owns NarrativeStateManager instead of the injected runtime binding")
plane_binding = section(game_start, "plane_reconciler.bind_runtime({", "scene_manager.set_active_plane_getter")
plane_binding_keys = re.findall(r'^\s*"([A-Za-z][A-Za-z0-9]+)"\s*:', plane_binding, flags=re.MULTILINE)
require(plane_binding_keys == [
    "narrative", "setPlayerMovementModifier", "setPlaneInteractionPolicy", "refreshEntitiesForPlaneChange",
    "refreshZonesForPlaneChange", "setCameraZoom", "restoreSceneCameraZoom",
    "applyPlaneLightEnvOverride", "damagePlayer", "getGameState",
], f"Godot Game PlaneReconciler runtime binding shape/order drift: {plane_binding_keys}")
require("await health_system.damage(float(amount))" in plane_binding
        and "scene_manager.set_active_plane_getter" in game_start
        and "await plane_reconciler.load_defs()" in gd_startup_load_phase
        and "if not plane_reconciler.load_defs()" not in gd_startup_load_phase,
        "Godot Game PlaneReconciler Promise/runtime/SceneManager wiring drift")

require(ordered_tokens(ts_smell_system, [
    "function emptyLayer()", "function normalizeLayer(", "const s = String(scent ?? '')",
    "const n = Number(intensity)", "const d = Number(dir)", "Number.isFinite(n)",
    "Math.max(0, Math.min(100, n))", "dir !== undefined && Number.isFinite(d)",
    "Math.max(-1, Math.min(1, d))", "flicker: !!flicker", "const MANUAL_ZONE_KEY",
    "private readonly eventBus", "private readonly flagStore", "private action", "private zone",
    "private activeZoneSmells", "private readonly onZoneEnter", "private readonly onZoneExit",
    "constructor(", "init(_ctx", "update(_dt", "private resolve(", "private refreshZoneLayer(",
    "setSmell(", "clearSmell(", "setZoneSmell(", "clearZoneSmell(", "sniff(", "getScent(",
    "getIntensity(", "getSource(", "getDebugState(", "private syncFlags(", "private emitChanged(",
    "serialize()", "deserialize(", "destroy()",
]), "TypeScript SmellSystem field/method architecture drift")
smell_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_smell_system, flags=re.MULTILINE)
smell_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_smell_system, flags=re.MULTILINE)
require(smell_fields == [
    "event_bus", "flag_store", "action", "zone", "active_zone_smells", "on_zone_enter", "on_zone_exit",
], f"Godot SmellSystem field architecture/order drift: {smell_fields}")
require(smell_methods == [
    "_empty_layer", "_normalize_layer", "_js_number", "_is_js_undefined", "_js_array_string",
    "_parse_prefixed_integer", "_js_boolean", "_init", "init", "update", "_resolve",
    "_refresh_zone_layer", "set_smell", "clear_smell", "set_zone_smell", "clear_zone_smell",
    "sniff", "get_scent", "get_intensity", "get_source", "get_debug_state", "_sync_flags",
    "_emit_changed", "serialize", "deserialize", "destroy",
], f"Godot SmellSystem method architecture/order drift: {smell_methods}")
smell_normalize = gd_function(gd_smell_system, "_normalize_layer")
smell_number = gd_function(gd_smell_system, "_js_number")
require(ordered_tokens(smell_normalize, [
    "var id := str(scent) if scent != null else", "if id.is_empty():", "return _empty_layer()",
    "var numeric_intensity := _js_number(intensity)", "var numeric_dir := _js_number(dir)",
    '"intensity": clampf(numeric_intensity, 0.0, 100.0)', "is_finite(numeric_intensity)",
    '"dir": clampf(numeric_dir, -1.0, 1.0)', "not _is_js_undefined(dir)",
    '"flicker": _js_boolean(flicker)',
]), "Godot SmellSystem normalizeLayer ordering/clamp/default drift")
require(ordered_tokens(smell_number, [
    "if _is_js_undefined(value):", "return NAN", "if value == null:", "return 0.0",
    "if value is bool:", "if value is int or value is float:", "if value is Array:",
    "_js_array_string(value)", "if value is Dictionary or value is Object:", "return NAN",
    "if text.is_empty():", "return 0.0", 'text == "Infinity"', 'text == "-Infinity"',
    'begins_with("0x")', 'begins_with("0b")', 'begins_with("0o")',
]), "Godot SmellSystem JavaScript Number adapter drift")
smell_constructor = gd_function(gd_smell_system, "_init")
smell_init = gd_function(gd_smell_system, "init")
require(ordered_tokens(smell_constructor, [
    "event_bus = next_event_bus", "flag_store = next_flag_store", "on_zone_enter = func",
    'payload.get("zone")', "if not entered_zone is Dictionary:", 'entered_zone.get("id", "")',
    'entered_zone.get("smell")', "active_zone_smells[id] = _normalize_layer(",
    'config.get("intensity", JS_UNDEFINED)', 'config.get("dir", JS_UNDEFINED)', "_refresh_zone_layer()",
    "on_zone_exit = func", 'payload.has("zoneId")', 'payload.get("zoneId") != null',
    'payload.get("zone") is Dictionary', 'id_value = payload.zone.get("id")',
    "not id.is_empty() and active_zone_smells.erase(id)", "_refresh_zone_layer()",
]), "Godot SmellSystem constructor-bound zone callback/nullish architecture drift")
require(ordered_tokens(smell_init, [
    'event_bus.off("zone:enter", on_zone_enter)', 'event_bus.off("zone:exit", on_zone_exit)',
    'event_bus.on("zone:enter", on_zone_enter)', 'event_bus.on("zone:exit", on_zone_exit)',
    "action = _empty_layer()", "zone = _empty_layer()", "active_zone_smells.clear()",
    "_sync_flags()", "_emit_changed()",
]), "Godot SmellSystem init callback identity/reset/order drift")
smell_resolve = gd_function(gd_smell_system, "_resolve")
smell_refresh = gd_function(gd_smell_system, "_refresh_zone_layer")
require(ordered_tokens(smell_resolve, [
    "if not action.scent.is_empty():", '"source": "action"', "if not zone.scent.is_empty():",
    '"source": "zone"', '"source": "none"',
]), "Godot SmellSystem action-over-zone resolution drift")
require(ordered_tokens(smell_refresh, [
    "var dominant := _empty_layer()", "for layer: Dictionary in active_zone_smells.values():",
    "dominant = layer", "zone = dominant.duplicate(false)", "_sync_flags()", "_emit_changed()",
]) and "duplicate(true)" not in smell_refresh,
        "Godot SmellSystem Map insertion order/shallow zone-copy drift")
smell_set = gd_function(gd_smell_system, "set_smell")
smell_set_zone = gd_function(gd_smell_system, "set_zone_smell")
smell_clear_zone = gd_function(gd_smell_system, "clear_zone_smell")
smell_sniff = gd_function(gd_smell_system, "sniff")
require(ordered_tokens(smell_set, [
    "action = _normalize_layer(", "JS_UNDEFINED if intensity == null else intensity",
    "JS_UNDEFINED if dir == null else dir", "_sync_flags()", "_emit_changed()",
]), "Godot SmellSystem setSmell optional/action/sync order drift")
require(ordered_tokens(smell_set_zone, [
    "var layer := _normalize_layer(", "JS_UNDEFINED if intensity == null else intensity",
    "JS_UNDEFINED if dir == null else dir", "if not layer.scent.is_empty():",
    "active_zone_smells[MANUAL_ZONE_KEY] = layer", "else:", "active_zone_smells.erase(MANUAL_ZONE_KEY)",
    "_refresh_zone_layer()",
]) and ordered_tokens(smell_clear_zone, [
    "if active_zone_smells.erase(MANUAL_ZONE_KEY):", "_refresh_zone_layer()",
]), "Godot SmellSystem manual zone Map ownership drift")
require(ordered_tokens(smell_sniff, [
    "var resolved := _resolve()", "if resolved.layer.scent.is_empty():", "return",
    'event_bus.emit("player:smellSniff", {"scent": resolved.layer.scent})',
]), "Godot SmellSystem sniff no-scent/event semantics drift")
smell_debug = gd_function(gd_smell_system, "get_debug_state")
smell_sync = gd_function(gd_smell_system, "_sync_flags")
smell_emit = gd_function(gd_smell_system, "_emit_changed")
require(smell_debug.count("duplicate(false)") == 3 and "duplicate(true)" not in smell_debug,
        "Godot SmellSystem debug state no longer returns three shallow layer copies")
require(ordered_tokens(smell_sync, [
    'flag_store.set_value("current_smell", resolved.layer.scent)',
    'flag_store.set_value("smell_intensity", resolved.layer.intensity)',
    'flag_store.set_value("current_smell_dir", resolved.layer.dir)',
    'flag_store.set_value("current_smell_flicker", resolved.layer.flicker)',
    'flag_store.set_value("current_smell_source", resolved.source)',
]), "Godot SmellSystem FlagStore projection/order drift")
require(ordered_tokens(smell_emit, [
    'event_bus.emit("player:smellChanged"', '"scent": resolved.layer.scent',
    '"intensity": resolved.layer.intensity', '"dir": resolved.layer.dir',
    '"flicker": resolved.layer.flicker', '"source": resolved.source',
]), "Godot SmellSystem changed-event payload/order drift")
smell_serialize = gd_function(gd_smell_system, "serialize")
smell_deserialize = gd_function(gd_smell_system, "deserialize")
smell_destroy = gd_function(gd_smell_system, "destroy")
require('return {"action": action.duplicate(false)}' in smell_serialize
        and "zone" not in smell_serialize and "duplicate(true)" not in smell_serialize,
        "Godot SmellSystem serialize persists more than the shallow action layer")
require(ordered_tokens(smell_deserialize, [
    'data.has("action") and data.get("action") != null',
    'if source == null and data.get("scent") is String:', "source = data", "if _js_boolean(source):",
    "var source_dict: Dictionary = source if source is Dictionary else {}", '"scent":',
    'source_dict.get("scent") is String', '"intensity":', 'source_dict.get("intensity") is int',
    '"dir":', 'source_dict.get("dir") is int', '"flicker":', 'source_dict.get("flicker") is bool',
    "_sync_flags()", "_emit_changed()",
]), "Godot SmellSystem deserialize nullish/legacy/Partial-layer drift")
require(ordered_tokens(smell_destroy, [
    'event_bus.off("zone:enter", on_zone_enter)', 'event_bus.off("zone:exit", on_zone_exit)',
    "active_zone_smells.clear()",
]) and "action" not in smell_destroy and "zone =" not in smell_destroy,
        "Godot SmellSystem destroy listener/Map-only ownership drift")
for forbidden_smell_api in [
    "var _event_bus", "var _flag_store", "var _action", "var _zone", "var _active_zone_smells",
    "func _on_zone_enter", "func _on_zone_exit", "debug_snapshot_fragment", "duplicate(true)",
]:
    require(forbidden_smell_api not in gd_smell_system,
            f"Godot SmellSystem retains invented/deep-copy target-only API/state: {forbidden_smell_api}")
require(ordered_tokens(section(action_registry, 'executor.register("setSmell"', 'executor.register("clearSmell"'), [
    'p.has("intensity") else null', 'p.has("dir") else null', 'p.has("flicker") else null',
    'd.smellSystem.set_smell(_nullish_string(p.get("scent")), intensity, direction, flicker)',
]), "Godot ActionRegistry setSmell optional-argument bridge drift")
require(ordered_tokens(section(bootstrap, '"smellDebug": {', '"getForm":'), [
    '"set": Callable(smell_system, "set_smell")', '"clear": Callable(smell_system, "clear_smell")',
    '"setZone": Callable(smell_system, "set_zone_smell")',
    '"clearZone": Callable(smell_system, "clear_zone_smell")', '"sniff": Callable(smell_system, "sniff")',
]), "Godot Game smell debug binding no longer delegates directly to SmellSystem")

require(ordered_tokens(ts_pressure_hold_manager, [
    "private readonly actionExecutor", "private assetManager", "private binding", "private defs", "private running",
    "constructor(", "init(ctx", "update(_dt", "serialize()", "deserialize(_data", "destroy()",
    "bindRuntime(", "async loadDefs()", "async runUntilDone(", "this.running = true", "try {",
    "return await this.runFlow", "finally", "this.running = false", "getDebugPreviewRequest(",
    "private async runFlow(", "private async finishAborted(", "private validateDef(",
    "validateInterruptChain(interrupts)", "export function parseHexColor(",
]), "TypeScript PressureHoldManager field/method/control-flow architecture drift")
pressure_hold_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_pressure_hold_manager, flags=re.MULTILINE)
pressure_hold_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_pressure_hold_manager, flags=re.MULTILINE)
require(pressure_hold_fields == ["action_executor", "asset_manager", "binding", "defs", "running"],
        f"Godot PressureHoldManager field architecture/order drift: {pressure_hold_fields}")
require(pressure_hold_methods == [
    "_init", "init", "update", "serialize", "deserialize", "destroy", "bind_runtime", "load_defs",
    "run_until_done", "get_debug_preview_request", "_run_flow", "_finish_aborted", "_validate_def",
    "parse_hex_color", "_js_number",
], f"Godot PressureHoldManager method architecture/order drift: {pressure_hold_methods}")
pressure_hold_load = gd_function(gd_pressure_hold_manager, "load_defs")
pressure_hold_run = gd_function(gd_pressure_hold_manager, "run_until_done")
pressure_hold_flow = gd_function(gd_pressure_hold_manager, "_run_flow")
pressure_hold_destroy = gd_function(gd_pressure_hold_manager, "destroy")
require("defs.clear()" not in pressure_hold_load and "duplicate(" not in pressure_hold_load and "defs[definition.id] = definition" in pressure_hold_load,
        "Godot PressureHoldManager loadDefs no longer preserves source Map/set object semantics")
require(ordered_tokens(pressure_hold_run, [
    "defs.get(id)", "binding", "if running:", "running = true", "await _run_flow(definition, binding)",
    "running = false", "return result",
]), "Godot PressureHoldManager runUntilDone guard/finally order drift")
require(pressure_hold_flow.count('\"releaseHint\": release_hint') == 2
        and pressure_hold_flow.count('\"barColor\": bar_color') == 2
        and pressure_hold_flow.count('\"abortOnReleaseFromRatio\": definition.get(\"abortOnReleaseFromRatio\")') == 2,
        "Godot PressureHoldManager runFlow request shape no longer matches source explicit undefined-valued keys")
require(ordered_tokens(pressure_hold_destroy, ["defs.clear()", "binding = null", "running = false"])
        and "asset_manager" not in pressure_hold_destroy,
        "Godot PressureHoldManager destroy ownership drift")
for forbidden_pressure_api in [
    "cancelSegment", "cancel_segment", "register_def_for_test", "has_def", "get_def_count", "is_running",
    "_make_segment_request", "_resolve_text", "_action_list", '\"invalid\"', '\"FAILED\"',
]:
    require(forbidden_pressure_api not in gd_pressure_hold_manager,
            f"Godot PressureHoldManager retains target-only API/state: {forbidden_pressure_api}")
pressure_hold_binding = section(game_start, "pressure_hold_manager.bind_runtime({", "water_minigame_manager.bind_runtime({")
require('\"resolveDisplayText\": Callable(self, \"resolve_display_text\")' in pressure_hold_binding
        and '\"runSegment\": Callable(self, \"_run_pressure_hold_segment\")' in pressure_hold_binding
        and "cancelSegment" not in pressure_hold_binding,
        "Godot Game PressureHold runtime-binding shape drift")
pressure_action_handler = section(action_registry, 'executor.register("startPressureHold"', 'executor.register("playSignalCue"')
require(ordered_tokens(pressure_action_handler, [
    "await d.pressureHoldManager.run_until_done(id)", "if result is bool and result == false:", "return false", "return",
]),
        "Godot startPressureHold handler does not preserve source rejected-Promise propagation")

require(ordered_tokens(ts_signal_cue_manager, [
    "private readonly actionExecutor", "private assetManager", "private defs", "private inFlight",
    "constructor(", "init(ctx", "update(_dt", "serialize()", "deserialize(_data", "destroy()",
    "async loadDefs()", "for (const def of defs)", "this.defs.set(id, def)", "async play(cueId",
    "this.inFlight.add(id)", "await this.actionExecutor.executeBatchAwait(def.actions)",
    "finally", "this.inFlight.delete(id)",
]), "TypeScript SignalCueManager field/method/control-flow architecture drift")
signal_cue_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_signal_cue_manager, flags=re.MULTILINE)
signal_cue_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_signal_cue_manager, flags=re.MULTILINE)
require(signal_cue_fields == ["action_executor", "asset_manager", "defs", "in_flight"], f"Godot SignalCueManager field architecture/order drift: {signal_cue_fields}")
require(signal_cue_methods == ["_init", "init", "update", "serialize", "deserialize", "destroy", "load_defs", "play"], f"Godot SignalCueManager method architecture/order drift: {signal_cue_methods}")
signal_cue_load = gd_function(gd_signal_cue_manager, "load_defs")
signal_cue_play = gd_function(gd_signal_cue_manager, "play")
require("defs.clear()" not in signal_cue_load and "duplicate(" not in signal_cue_load and "defs[id] = definition" in signal_cue_load,
        "Godot SignalCueManager loadDefs no longer preserves source Map/set object semantics")
require(ordered_tokens(signal_cue_play, ["defs.get(id)", "in_flight.has(id)", "in_flight[id] = true", "await action_executor.execute_batch_await(definition.actions)", "in_flight.erase(id)"]),
        "Godot SignalCueManager play order/final cleanup drift")
require("func has_cue" not in gd_signal_cue_manager and "-> bool" not in signal_cue_play,
        "Godot SignalCueManager retains target-only query/return APIs")

require(ordered_tokens(ts_health_system, [
    "const DEFAULT_HEALTH_CONFIG", "private readonly eventBus", "private readonly flagStore",
    "private readonly actionExecutor", "private config", "private currentHealth", "private maxHealth",
    "private tethering", "constructor(", "configure(", "init(_ctx", "update(_dt", "getHealth()",
    "getMaxHealth()", "async damage(", "heal(", "setHealth(", "tether():", "private async triggerDeathTether",
    "private syncFlags", "private emitChanged", "serialize()", "deserialize(", "destroy()",
]), "TypeScript HealthSystem field/method architecture drift")
health_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_health_system, flags=re.MULTILINE)
health_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_health_system, flags=re.MULTILINE)
require(health_fields == ["event_bus", "flag_store", "action_executor", "config", "current_health", "max_health", "tethering"],
        f"Godot HealthSystem field architecture/order drift: {health_fields}")
require(health_methods == ["_init", "configure", "init", "update", "get_health", "get_max_health", "damage", "heal", "set_health", "tether", "_trigger_death_tether", "_sync_flags", "_emit_changed", "serialize", "deserialize", "destroy"],
        f"Godot HealthSystem method architecture/order drift: {health_methods}")
health_init = gd_function(gd_health_system, "init")
health_tether = gd_function(gd_health_system, "_trigger_death_tether")
require("tethering" not in health_init, "Godot HealthSystem init invents a source-absent in-flight reset")
require(ordered_tokens(health_tether, [
    "if tethering:", "tethering = true", "current_health = 0.0", "_sync_flags()", "_emit_changed()",
    "flag_store.get_value", "tethering = false", "await action_executor.execute_batch_await([",
    "push_warning(\"HealthSystem: death-tether actions failed\")", "current_health = maxf(1.0",
    "_sync_flags()", "_emit_changed()", "tethering = false",
]), "Godot HealthSystem death-tether control-flow/order drift")
require("debug_snapshot_fragment" not in gd_health_system and "DEFAULT_CONFIG" not in gd_health_system,
        "Godot HealthSystem retains target-only class surface")

require(ordered_tokens(ts_minigame_session, [
    "export class MinigameActionPlaybackGate", "private depth", "constructor(", "private readonly executeBatch",
    "private readonly hooks", "get locked", "async run(", "this.depth++", "onLockChanged?.(true)",
    "await this.executeBatch(actions)", "finally", "this.depth--", "onLockChanged?.(false)",
    "restoreMinigameState?.()", "export abstract class MinigameSessionManagerBase",
    "protected assetManager", "protected renderer", "protected inputManager", "protected stateController",
    "protected index", "private instanceCache", "protected scene", "private activeScopeId", "protected active",
    "get isActive", "protected prevState", "private unsubKey", "private sessionResolve", "protected lastResult",
    "private onSessionEnd", "private startInFlight", "private sessionEpoch", "protected abstract readonly indexUrl",
    "protected abstract readonly dataSubdir", "protected abstract readonly scopePrefix", "protected abstract readonly systemLabel",
]), "TypeScript MinigameSession field/gate architecture drift")
minigame_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_session, flags=re.MULTILINE)
minigame_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_session, flags=re.MULTILINE)
require(minigame_fields == [
    "asset_manager", "renderer", "input_manager", "state_controller", "index", "instance_cache", "scene",
    "active_scope_id", "active", "prev_state", "unsub_key", "session_resolve", "last_result", "on_session_end",
    "start_in_flight", "session_epoch", "index_url", "data_subdir", "scope_prefix", "system_label",
], f"Godot MinigameSession field architecture/order drift: {minigame_fields}")
require(minigame_methods == [
    "is_active", "build_instance_manifest_refs", "create_scene", "load_scene_content", "tick_scene",
    "validate_instance", "prepare_instance", "on_session_active", "on_scene_loaded", "on_teardown",
    "on_session_key_down", "runtime_ready", "warn_session", "init", "update", "serialize", "deserialize",
    "destroy", "set_on_session_end", "load_index", "get_instance_list", "run_until_done", "start",
    "_handle_session_key_down", "load_instance", "teardown_session", "restore_minigame_state_after_action",
    "_release_active_scope", "_remove_scene", "resolve_session",
], f"Godot MinigameSession method architecture/order drift: {minigame_methods}")
minigame_run = gd_function(gd_minigame_session, "run_until_done")
minigame_start = gd_function(gd_minigame_session, "start")
minigame_teardown = gd_function(gd_minigame_session, "teardown_session")
require(ordered_tokens(minigame_run, ["active or start_in_flight or session_resolve != null", "session_resolve = latch", "start(id)", "await latch.wait()", "return last_result"]),
        "Godot MinigameSession runUntilDone Promise/resolver order drift")
require(ordered_tokens(minigame_start, [
    "if not runtime_ready()", "resolve_session()", "if active or start_in_flight", "start_in_flight = true",
    "var epoch := session_epoch", "await load_instance(id)", "if epoch != session_epoch", "validate_instance(instance_zero)",
    "prepare_instance(instance_zero)", "active_scope_id = scope_id", "asset_manager.preload_manifest(",
    "if epoch != session_epoch", "prev_state = state_controller.current_state", "set_state(RuntimeDataTypes.MINIGAME)",
    "set_game_keyboard_blocked(true)", "active = true", "last_result = null", "on_session_active(instance)",
    "subscribe_key_down", "create_scene(instance)", "await load_scene_content(next_scene, instance)",
    "if epoch != session_epoch or not active or scene != next_scene", "add_child(root)", "on_scene_loaded(instance)",
    "start_in_flight = false",
]), "Godot MinigameSession start transaction/order drift")
require("while active" not in minigame_start and "session_waiting" not in gd_minigame_session and "_destroyed" not in gd_minigame_session,
        "Godot MinigameSession still makes start wait for teardown or retains target-only lifecycle guards")
require(ordered_tokens(minigame_teardown, [
    "if not active", "session_epoch += 1", "active = false", "on_teardown()", "unsub_key.call()",
    "unsub_key = null", "set_game_keyboard_blocked(false)", "_release_active_scope()", "_remove_scene()",
    "set_state(prev_state)", "resolve_session()", "on_session_end.call()",
]), "Godot MinigameSession teardown order drift")
require("teardown_session" not in gd_function(gd_minigame_session, "deserialize") and
        ordered_tokens(gd_function(gd_minigame_session, "resolve_session"), ["session_resolve = null", "queue_microtask(Callable(resolver, \"resolve\"))"]),
        "Godot MinigameSession deserialize/resolver microtask semantics drift")
for forbidden_minigame_api in ["bind_session_runtime", "publish_result", "get_index_url", "get_data_subdir", "get_scope_prefix", "_scene_root", "_unsubscribe_input"]:
    require(forbidden_minigame_api not in gd_minigame_session, f"Godot MinigameSession retains target-only API: {forbidden_minigame_api}")
gate_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_action_gate, flags=re.MULTILINE)
gate_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_action_gate, flags=re.MULTILINE)
require(gate_fields == ["depth", "execute_batch", "hooks"] and gate_methods == ["_init", "is_locked", "run"],
        f"Godot MinigameActionPlaybackGate architecture drift: {gate_fields}/{gate_methods}")
require(ordered_tokens(gd_function(gd_minigame_action_gate, "run"), [
    "actions == null or actions.is_empty()", "depth += 1", "depth == 1", "onLockChanged.call(true)",
    "await execute_batch.call(actions)", "depth -= 1", "depth == 0", "onLockChanged.call(false)",
    "restoreMinigameState.call()",
]) and "maxi(" not in gd_minigame_action_gate, "Godot MinigameActionPlaybackGate run/finally order drift")

require(ordered_tokens(ts_paper_craft_manager, [
    "protected readonly indexUrl", "protected readonly dataSubdir", "protected readonly scopePrefix",
    "protected readonly systemLabel", "private eventBus", "private actionExecutor", "private resolveTextFn",
    "init(ctx", "bindRuntime(", "protected runtimeReady", "protected createScene", "protected loadSceneContent",
    "protected tickScene", "protected buildInstanceManifestRefs", "private publishResult", "getDebugVisualState",
]), "TypeScript PaperCraftMinigameManager field/method architecture drift")
paper_manager_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_paper_craft_manager, flags=re.MULTILINE)
paper_manager_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_paper_craft_manager, flags=re.MULTILINE)
require(paper_manager_fields == ["event_bus", "action_executor", "resolve_text_fn"],
        f"Godot PaperCraftMinigameManager field architecture/order drift: {paper_manager_fields}")
require(paper_manager_methods == ["_init", "init", "bind_runtime", "runtime_ready", "create_scene", "load_scene_content", "tick_scene", "build_instance_manifest_refs", "_publish_result", "get_debug_visual_state"],
        f"Godot PaperCraftMinigameManager method architecture/order drift: {paper_manager_methods}")
require(ordered_tokens(gd_function(gd_paper_craft_manager, "_init"), [
    "index_url = INDEX_URL", 'data_subdir = "paper_craft"', 'scope_prefix = "minigame:paperCraft"',
    'system_label = "PaperCraftMinigameManager"',
]), "Godot PaperCraftMinigameManager abstract-property initialization drift")
require(ordered_tokens(gd_function(gd_paper_craft_manager, "bind_runtime"), [
    'renderer = deps.get("renderer")', 'input_manager = deps.get("inputManager")',
    'state_controller = deps.get("stateController")', 'action_executor = deps.get("actionExecutor")',
    'resolve_text_fn = deps.get("resolveDisplayText")',
]), "Godot PaperCraftMinigameManager runtime dependency ownership/order drift")
paper_manifest = gd_function(gd_paper_craft_manager, "build_instance_manifest_refs")
require(ordered_tokens(paper_manifest, [
    'next_instance.get("backgroundImage")', '"扎纸背景: %s"', "for order: Variant in next_instance.orders",
    "for part: Variant in order.parts", 'part.get("image")', '"扎纸部件: %s"',
]) and 'str(path)' not in paper_manifest, "Godot PaperCraftMinigameManager manifest/null-path semantics drift")
require(ordered_tokens(gd_function(gd_paper_craft_manager, "_publish_result"), [
    "last_result = result", 'event_bus.emit("minigame:paperCraftResult", result)',
]), "Godot PaperCraftMinigameManager result ownership/order drift")

require(ordered_tokens(ts_paper_craft_scene, [
    "readonly root", "private readonly renderer", "private readonly assetManager",
    "private readonly actionExecutor", "private readonly resolveText", "private readonly onResult",
    "private readonly onClose", "private instance", "private order", "private bg", "private backgroundSprite",
    "private uiLayer", "private workLayer", "private paletteLayer", "private feedback", "private selectedPart",
    "private selectedPaper", "private selectedFinish", "private placed", "private textures", "private drag",
    "private unsubResize", "private closing", "private destroyed", "private orderIndex", "private finishing",
    "private paletteContentH", "private readonly actionGate", "constructor(", "isActionsPlaybackLocked",
    "getDebugVisualState", "private setInputLocked", "async load", "private async enterOrder", "update(",
    "private onResize", "abort()", "destroy()", "private async loadTextures", "private rebuild", "private layout",
    "private buildSlots", "private makeSlot", "private buildPalette", "private makePaletteItem",
    "private onDragMove", "private onDragEnd", "private buildPaperButtons", "private buildFinishButtons",
    "private buildTopChrome", "private makeSmallButton", "private async finish", "private calculateResult",
    "private slotRejectsText", "private updateFeedback", "private makePartVisual", "private partImage",
    "private getPaperOptions", "private getFinishOptions", "private parseColor",
]), "TypeScript PaperCraftMinigameScene field/method architecture drift")
paper_scene_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_paper_craft_scene, flags=re.MULTILINE)
paper_scene_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_paper_craft_scene, flags=re.MULTILINE)
require(paper_scene_fields == [
    "root", "renderer", "asset_manager", "action_executor", "resolve_text", "on_result", "on_close",
    "instance", "order", "bg", "background_sprite", "ui_layer", "work_layer", "palette_layer", "feedback",
    "selected_part", "selected_paper", "selected_finish", "placed", "textures", "drag", "unsub_resize",
    "closing", "destroyed", "order_index", "finishing", "palette_content_h", "action_gate",
], f"Godot PaperCraftMinigameScene field architecture/order drift: {paper_scene_fields}")
require(paper_scene_methods == [
    "_init", "is_actions_playback_locked", "get_debug_visual_state", "_set_input_locked", "load",
    "_enter_order", "update", "_on_resize", "abort", "destroy", "_load_textures", "_rebuild", "_layout",
    "_build_slots", "_make_slot", "_build_palette", "_make_palette_item", "_on_drag_move", "_on_drag_end",
    "_build_paper_buttons", "_build_finish_buttons", "_build_top_chrome", "_make_small_button", "_finish",
    "_calculate_result", "_slot_rejects_text", "_update_feedback", "_make_part_visual", "_part_image",
    "_get_paper_options", "_get_finish_options", "_parse_color",
    # Godot signal/rendering adapters begin only after the translated source surface.
    "_on_slot_pressed_adapter", "_on_part_pressed_adapter", "_on_part_gui_input_adapter",
    "_on_root_gui_input_adapter", "_select_paper_adapter", "_select_finish_adapter", "_clear_layer",
    "_set_gui_input_enabled", "_event_global_position", "_root_local_from_global", "_resolve", "_label",
    "_system_ui_font", "_panel_style", "_apply_button_style", "_color_from_rgb",
], f"Godot PaperCraftMinigameScene method architecture/order drift: {paper_scene_methods}")
paper_scene_init = gd_function(gd_paper_craft_scene, "_init")
require(ordered_tokens(paper_scene_init, [
    "renderer = next_renderer", "asset_manager = next_asset_manager", "action_executor = next_action_executor",
    "resolve_text = next_resolve_text", "on_result = next_on_result", "on_close = next_on_close",
    "action_gate = RuntimeMinigameActionPlaybackGate.new(", "root = Control.new()", "root.add_child(bg)",
    "root.add_child(work_layer)", "root.add_child(palette_layer)", "root.add_child(ui_layer)",
    "ui_layer.add_child(feedback)", 'subscribe_after_resize(Callable(self, "_on_resize"))',
]), "Godot PaperCraftMinigameScene constructor dependency/gate/layer order drift")
paper_scene_load = gd_function(gd_paper_craft_scene, "load")
require(ordered_tokens(paper_scene_load, [
    "instance = next_instance", 'instance.get("orders")', 'instance.orders.is_empty()',
    'next_order.get("paperOptions")', 'next_order.get("finishOptions")',
    'instance.get("backgroundImage")', "asset_manager.load_texture(background_image)",
    "await RuntimeMicrotaskQueueScript.yield_turn()", "background_sprite = TextureRect.new()",
    "root.add_child(background_sprite)", "root.move_child(background_sprite, 1)", "await _enter_order(0)",
]), "Godot PaperCraftMinigameScene load validation/background/entry order drift")
paper_enter_order = gd_function(gd_paper_craft_scene, "_enter_order")
require(ordered_tokens(paper_enter_order, [
    "order_index = index", "order = instance.orders[index]", "placed.clear()", "selected_part = null",
    "_get_paper_options()", "_get_finish_options()", "selected_paper = paper_options[0]",
    "selected_finish = finish_options[0]", "await _load_textures()", "if closing or destroyed", "_rebuild()",
]), "Godot PaperCraftMinigameScene raw-order selection/load continuation drift")
require(ordered_tokens(gd_function(gd_paper_craft_scene, "_rebuild"), [
    "_clear_layer(work_layer)", "_clear_layer(palette_layer)", "_clear_layer(ui_layer, feedback)",
    "ui_layer.add_child(feedback)", "_build_slots()", "_build_palette()", "_build_paper_buttons()",
    "_build_finish_buttons()", "_build_top_chrome()", "_update_feedback()", "_layout()",
]), "Godot PaperCraftMinigameScene stable-layer rebuild order drift")
paper_make_slot = gd_function(gd_paper_craft_scene, "_on_slot_pressed_adapter")
require(ordered_tokens(paper_make_slot, [
    "if selected_part == null", "placed.has(slot_id)", "placed.erase(slot_id)",
    'slot.accepts.has(str(selected_part.get("id", "")))', "feedback.text = _slot_rejects_text",
    "placed[slot_id] = selected_part", "selected_part = null", "_rebuild()",
]), "Godot PaperCraftMinigameScene slot closure/raw-part identity drift")
paper_drag_end = gd_function(gd_paper_craft_scene, "_on_drag_end")
require(ordered_tokens(paper_drag_end, [
    "work_layer.get_global_transform_with_canvas().affine_inverse()", "for candidate: Variant in order.get(\"slots\", [])",
    'matched_slot.accepts.has(str(dragged_part.get("id", "")))',
    'placed[str(matched_slot.get("id", ""))] = dragged_part', "selected_part = null",
    "feedback.text = _slot_rejects_text", "drag = null", "root.gui_input.disconnect(root_callback)", "_rebuild()",
]), "Godot PaperCraftMinigameScene drag/drop cleanup/raw-part identity drift")
paper_finish = gd_function(gd_paper_craft_scene, "_finish")
require(ordered_tokens(paper_finish, [
    "if finishing", 'slot.get("optional") != true', "not placed.has", "feedback.text = RuntimeFillTemplateScript.fill_token",
    "finishing = true", "var result := _calculate_result()", "on_result.call(result)",
    'result.level == "success"', 'result.level == "warn"', "await action_gate.run(actions)",
    "if closing or destroyed", "order_index < instance.orders.size() - 1", "await _enter_order(order_index + 1)",
    "abort()", "finishing = false",
]), "Godot PaperCraftMinigameScene finish guard/result/action/advance order drift")
paper_result = gd_function(gd_paper_craft_scene, "_calculate_result")
require(ordered_tokens(paper_result, [
    "var tags: Array[String]", "var score", "var paper: Variant = selected_paper",
    "var finish: Variant = selected_finish", 'paper.get("score", 0)', 'order.get("correctPaper")',
    'paper.get("tags", [])', 'finish.get("score", 0)', 'finish.get("tags", [])',
    "for part: Variant in placed.values()", 'part.get("score", 0)', 'part.get("tags", [])',
    'order.get("successScore", 76)', 'order.get("warnScore", 50)',
    "for slot_id: Variant in placed", '"partId": str(part.get("id", ""))',
    '"paperId": str(paper.get("id", ""))', '"finishId": str(finish.get("id", ""))',
]), "Godot PaperCraftMinigameScene result scoring/Set/Map projection drift")
for forbidden_paper_scene_api in [
    "func get_root", "func get_feedback_text", "func debug_select", "func debug_place", "func debug_submit",
    "selected_part_id", "selected_paper_id", "selected_finish_id", "part_textures", "_find_by_id",
    "_place_part", "PIXI_COMPOSITE_SHADER", "_wrap_content_for_pixi_phase",
]:
    require(forbidden_paper_scene_api not in gd_paper_craft_scene,
            f"Godot PaperCraftMinigameScene retains flattened/target-only surface: {forbidden_paper_scene_api}")

require(ordered_tokens(ts_fill_template, ["export function fillToken", "str.replace(token, () => value)", "export function fillTemplate", "Object.entries(map)", "fillToken(out, token, value)"]),
        "TypeScript fillTemplate literal-first-replacement architecture drift")
fill_template_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_fill_template, flags=re.MULTILINE)
require(fill_template_methods == ["fill_token", "fill_template"], f"Godot fillTemplate method architecture/order drift: {fill_template_methods}")
require(ordered_tokens(gd_function(gd_fill_template, "fill_token"), [
    "text.find(token)", "if index < 0", "text.substr(0, index) + value + text.substr(index + token.length())",
]), "Godot fillToken no-match/first-literal-replacement semantics drift")
require(ordered_tokens(gd_function(gd_fill_template, "fill_template"), [
    "var result := text", "for token: Variant in replacements", "result = fill_token(result", "return result",
]), "Godot fillTemplate ordered replacement semantics drift")

require(ordered_tokens(ts_sugar_wheel_manager, [
    "protected readonly indexUrl", "protected readonly dataSubdir", "protected readonly scopePrefix",
    "protected readonly systemLabel", "private eventBus", "private resolveTextFn", "private actionExecutor",
    "private playSfx", "private debugSugarLog", "private evaluateBeforeChargeCondition", "init(ctx",
    "bindRuntime(", "protected runtimeReady", "protected warnSession", "protected validateInstance",
    "protected createScene", "protected loadSceneContent", "protected tickScene", "protected onSessionKeyDown",
    "protected buildInstanceManifestRefs", "private publishResult", "showSpeech", "dismissSpeech",
    "dismissAllSpeech", "resetPointerGeomAngleDeg", "getDebugVisualState",
]), "TypeScript SugarWheelMinigameManager field/method architecture drift")
sugar_manager_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_manager, flags=re.MULTILINE)
sugar_manager_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_manager, flags=re.MULTILINE)
require(sugar_manager_fields == ["event_bus", "resolve_text_fn", "action_executor", "play_sfx", "debug_sugar_log", "evaluate_before_charge_condition"],
        f"Godot SugarWheelMinigameManager field architecture/order drift: {sugar_manager_fields}")
require(sugar_manager_methods == [
    "_init", "init", "bind_runtime", "runtime_ready", "warn_session", "validate_instance", "create_scene",
    "load_scene_content", "tick_scene", "on_session_key_down", "build_instance_manifest_refs", "_publish_result",
    "show_speech", "dismiss_speech", "dismiss_all_speech", "reset_pointer_geom_angle_deg", "get_debug_visual_state",
], f"Godot SugarWheelMinigameManager method architecture/order drift: {sugar_manager_methods}")
require(ordered_tokens(gd_function(gd_sugar_wheel_manager, "_init"), [
    "index_url = INDEX_URL", 'data_subdir = "sugar_wheel"', 'scope_prefix = "minigame:sugarWheel"',
    'system_label = "SugarWheelMinigameManager"',
]), "Godot SugarWheelMinigameManager abstract-property initialization drift")
require(ordered_tokens(gd_function(gd_sugar_wheel_manager, "bind_runtime"), [
    'renderer = deps.get("renderer")', 'input_manager = deps.get("inputManager")',
    'state_controller = deps.get("stateController")', 'action_executor = deps.get("actionExecutor")',
    'play_sfx = deps.get("playSfx")', 'resolve_text_fn = deps.get("resolveDisplayText")',
    'debug_sugar_log = deps.get("debugPanelLog")', 'evaluate_before_charge_condition = deps.get("evaluateBeforeChargeCondition")',
]), "Godot SugarWheelMinigameManager runtime dependency ownership/order drift")
require(ordered_tokens(gd_function(gd_sugar_wheel_manager, "warn_session"), [
    "detail != null", "debug_sugar_log", '"[糖画转盘] %s"',
]) and "push_warning" not in gd_function(gd_sugar_wheel_manager, "warn_session"),
        "Godot SugarWheelMinigameManager warning-channel override drift")
sugar_key = gd_function(gd_sugar_wheel_manager, "on_session_key_down")
require(ordered_tokens(sugar_key, ["OS.is_debug_build()", '== "KeyD"', 'record.get("preventDefault")', "prevent_default.call()", "scene.toggle_geom_debug_overlay()"]),
        "Godot SugarWheelMinigameManager dev-key/preventDefault behavior drift")
sugar_manifest = gd_function(gd_sugar_wheel_manager, "build_instance_manifest_refs")
require(ordered_tokens(sugar_manifest, [
    'next_instance.get("backgroundImage")', 'next_instance.get("foregroundImage")',
    'next_instance.get("wheelImage")', 'next_instance.get("pointerImage")',
]) and 'str(path)' not in sugar_manifest, "Godot SugarWheelMinigameManager manifest/null-path semantics drift")
require(ordered_tokens(gd_function(gd_sugar_wheel_manager, "_publish_result"), [
    "last_result = result", 'event_bus.emit("minigame:sugarWheelResult", result)',
]), "Godot SugarWheelMinigameManager result ownership/order drift")
sugar_bind = section(bootstrap, "sugar_wheel_minigame_manager.bind_runtime({", "await sugar_wheel_minigame_manager.load_index()")
require(ordered_tokens(sugar_bind, [
    '"renderer": renderer', '"inputManager": input_manager', '"stateController": state_controller',
    '"actionExecutor": action_executor', '"playSfx": Callable(audio_manager, "play_sfx")',
    '"resolveDisplayText": Callable(self, "resolve_display_text")', '"debugPanelLog": func(message: String)',
    '"evaluateBeforeChargeCondition": Callable(self, "_evaluate_sugar_wheel_condition")',
]), "Godot Game SugarWheel bindRuntime dependency/order drift")

require(ordered_tokens(ts_sugar_wheel_spin_physics, [
    "export const TAU", "DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2",
    "MIN_SPIN_TERRAIN_WEIGHT", "DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2",
    "DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC", "export function finiteOr(",
    "export function clamp(", "export function lerp(", "export function normalizeAngle(",
    "export function degToRad(", "export interface SugarWheelSectorLayout",
    "export function sectorLayoutFromInstance(", "export function sectorIndexFromWheelGeomAngle(",
    "function sectorWeightOrDefault(", "export function spinWeightBiasScale(",
    "function weightTerrainHarmonicComponents(", "export function weightTerrainPotential(",
    "export function weightDerivedBiasAccel(", "export interface SpinStepInput",
    "export function advanceSugarWheelSpinStep(", "export function spinDragEffectiveK(",
    "export interface SimulateSugarWheelLandingOptions", "export function simulateSugarWheelLanding(",
]), "TypeScript sugarWheelSpinPhysics API/function architecture drift")
sugar_spin_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_spin_physics, flags=re.MULTILINE)
sugar_spin_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_spin_physics, flags=re.MULTILINE)
require(sugar_spin_fields == [], f"Godot sugarWheelSpinPhysics invents module state: {sugar_spin_fields}")
require(sugar_spin_methods == [
    "finite_or", "clamp", "lerp", "normalize_angle", "deg_to_rad", "sector_layout_from_instance",
    "sector_index_from_wheel_geom_angle", "_sector_weight_or_default", "spin_weight_bias_scale",
    "_weight_terrain_harmonic_components", "weight_terrain_potential", "weight_derived_bias_accel",
    "advance_sugar_wheel_spin_step", "spin_drag_effective_k", "simulate_sugar_wheel_landing",
], f"Godot sugarWheelSpinPhysics method architecture/order drift: {sugar_spin_methods}")
for forbidden_sugar_spin_api in [
    "func sector_layout(", "func sector_index(", "func weight_terrain_components(",
    "func advance_step(", "func simulate_landing(", "power_value: float, initial_phi",
]:
    require(forbidden_sugar_spin_api not in gd_sugar_wheel_spin_physics,
            f"Godot sugarWheelSpinPhysics retains flattened target-only API: {forbidden_sugar_spin_api}")
sugar_layout = gd_function(gd_sugar_wheel_spin_physics, "sector_layout_from_instance")
require(ordered_tokens(sugar_layout, [
    "var sectors: Array = instance.sectors", "var count := sectors.size()", "if count <= 0:",
    'return {"n": 0, "step": TAU, "left0": 0.0}', "var step := TAU / count",
    'finite_or(instance.get("sectorAngleOffsetDeg"), 0.0)', 'instance.get("sectorCenterPhase")',
    "is_finite(float(raw_phase))", "var left0 := offset + phase * step",
    'return {"n": count, "step": step, "left0": left0}',
]), "Godot sugarWheelSpinPhysics sector layout/phase/default topology drift")
sugar_sector_index = gd_function(gd_sugar_wheel_spin_physics, "sector_index_from_wheel_geom_angle")
require(ordered_tokens(sugar_sector_index, [
    "var count: int = layout.n", "var step: float = layout.step", "var left0: float = layout.left0",
    "if count <= 0:", "return 0", "normalize_angle(geom_mod - left0)",
    "floor(relative / step + 1e-9)", "posmod(posmod(index, count) + count, count)",
]), "Godot sugarWheelSpinPhysics sector index epsilon/modulo drift")
sugar_harmonic = gd_function(gd_sugar_wheel_spin_physics, "_weight_terrain_harmonic_components")
require(ordered_tokens(sugar_harmonic, [
    "var sectors: Array = instance.sectors", "sector_layout_from_instance(instance)",
    'return {"sinSum": 0.0, "cosSum": 0.0}', "for index: int in count:",
    "_sector_weight_or_default", "maxf(MIN_SPIN_TERRAIN_WEIGHT, raw_weight)",
    "var height := -log(terrain_weight)", "left0 + (index + 0.5) * step",
    "var difference := phi - center", "sin_sum += height * sin(difference)",
    "cos_sum += height * cos(difference)", 'return {"sinSum": sin_sum, "cosSum": cos_sum}',
]), "Godot sugarWheelSpinPhysics weight harmonic terrain topology drift")
sugar_advance = gd_function(gd_sugar_wheel_spin_physics, "advance_sugar_wheel_spin_step")
require(ordered_tokens(sugar_advance, [
    "var instance: Dictionary = input.instance", "var omega: float = input.omega",
    "var alpha: float = input.alpha", "var phi_geom: float = input.phiGeom",
    "var dt: float = input.dt", "dt = clamp(dt, 0.0, 0.05)",
    'finite_or(instance.get("spinAccelHalfLifeSec"), 0.42)',
    "alpha *= pow(0.5, dt / half_life)", "alpha = 0.0",
    "var k := spin_drag_effective_k(omega, instance)",
    "var bias_accel := weight_derived_bias_accel(phi_geom, instance)",
    'instance.get("spinWeightBiasCreepRefRadPerSec")',
    "DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC", "creep_ref = NAN",
    "absolute_omega < creep_ref", "bias_accel *= clamp(absolute_omega / creep_ref, 0.0, 1.0)",
    "omega += (alpha - k * omega + bias_accel) * dt",
    'instance.get("spinDryFrictionAccelRadPerSec2")',
    "DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2", "float(dry_config) <= 0.0", "dry = 0.0",
    "dry > 1e-11 and absf(omega) > 1e-24", "var sign_value := signf(omega)",
    "var decrement := dry * dt", "if absf(omega) <= decrement:", "omega = 0.0",
    "omega -= sign_value * decrement", "phi_geom = normalize_angle(phi_geom + omega * dt)",
    'return {"omega": omega, "alpha": alpha, "phiGeom": phi_geom}',
]), "Godot sugarWheelSpinPhysics step input/operation/dry-friction order drift")
sugar_drag = gd_function(gd_sugar_wheel_spin_physics, "spin_drag_effective_k")
require(ordered_tokens(sugar_drag, [
    'finite_or(instance.get("spinLinearDragPerSec"), 0.58)', "var floor_value := 0.035",
    'finite_or(instance.get("spinDragLowSpeedThresholdRadPerSec"), 0.0)',
    'finite_or(instance.get("spinDragLowSpeedBoostPerSec"), 0.0)',
    "threshold <= 1e-6 or boost <= 1e-6", "return maxf(floor_value, base)",
    "clamp(1.0 - absolute_omega / threshold, 0.0, 1.0)",
    "raw_t * raw_t * raw_t * (raw_t * (raw_t * 6.0 - 15.0) + 10.0)",
    "return maxf(floor_value, base + boost * blend)",
]), "Godot sugarWheelSpinPhysics drag floor/smootherstep drift")
sugar_simulate = gd_function(gd_sugar_wheel_spin_physics, "simulate_sugar_wheel_landing")
require(ordered_tokens(sugar_simulate, [
    "instance: Dictionary, rng: Callable, options: Dictionary = {}", "sector_layout_from_instance(instance)",
    "if int(layout.n) <= 0:", "return 0", 'options.has("initialPhiRad")',
    "normalize_angle(float(rng.call()) * TAU)", 'options.has("power")',
    "clamp(float(rng.call()), 0.0, 1.0)", 'instance.get("sectorDirection") == "counterclockwise"',
    "var omega: float = sign_value * lerp(", 'finite_or(instance.get("spinChargeMinVelocityRadPerSec"), 0.0)',
    'finite_or(instance.get("spinChargeMaxVelocityRadPerSec"), 11.0)',
    "var alpha: float = sign_value * lerp(", 'finite_or(instance.get("spinChargeMinAccelRadPerSec2"), 0.0)',
    'finite_or(instance.get("spinChargeMaxAccelRadPerSec2"), 9.0)', "var dt := 0.05",
    'options.get("maxSteps")', "max_steps = 400000",
    'finite_or(instance.get("spinStopSpeedRadPerSec"), 0.06)',
    'finite_or(instance.get("spinStopSettleSec"), 0.085)', "while index < float(max_steps):",
    "advance_sugar_wheel_spin_step({", '"instance": instance', '"omega": omega', '"alpha": alpha',
    '"phiGeom": phi', '"dt": dt', "if absf(omega) < stop_epsilon:", "settle_accum += dt",
    "if settle_accum >= settle_need:", "sector_index_from_wheel_geom_angle(phi, layout)",
    "settle_accum = 0.0", "return sector_index_from_wheel_geom_angle(phi, layout)",
]), "Godot sugarWheelSpinPhysics RNG/options/simulation topology drift")
ts_sugar_wheel_scene = read("src/systems/sugarWheel/SugarWheelMinigameScene.ts")
gd_sugar_wheel_scene = read("godot_port/scripts/minigames/sugar_wheel_scene.gd")
sugar_wheel_scene_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_scene, flags=re.MULTILINE)
sugar_wheel_scene_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_scene, flags=re.MULTILINE)
require(sugar_wheel_scene_fields == [
    "root", "renderer", "asset_manager", "action_executor", "resolve_text", "on_result", "on_close", "play_sfx",
    "instance", "bg", "wheel_layer", "ui_layer", "background_sprite", "foreground_sprite", "wheel_sprite",
    "pointer_sprite", "arc_power_ring", "result_banner", "result_banner_bg", "result_banner_text",
    "result_banner_anim", "hint_text", "charge_button", "charge_button_disk", "charge_button_glyph",
    "charge_button_hover", "close_icon_button", "speech_layer", "speech_entries", "confirm_layer", "confirm_shade",
    "confirm_panel", "confirm_text", "confirm_yes_button", "confirm_no_button", "confirm_visible", "phase",
    "charge_elapsed", "spin_omega", "spin_alpha", "spin_settle_accum", "last_result", "unsub_resize",
    "dragging_pointer", "geom_debug_gfx", "geom_debug_visible", "speech_debug_layer", "speech_debug_bg",
    "speech_debug_title", "speech_debug_button_area", "wheel_geom_radius_px", "geom_debug_rim_container",
    "geom_debug_hud", "atmosphere_scheduler", "last_atmosphere_phase", "action_gate", "action_input_shield",
    "debug_sugar_log", "evaluate_before_charge_condition", "charge_press_requested", "charge_pointer_held",
    "charge_release_requested", "launch_in_progress", "pending_charge_pass_actions", "last_spin_tick_sector_index",
    "last_spin_tick_at_ms",
], f"Godot SugarWheelMinigameScene field architecture/order drift: {sugar_wheel_scene_fields}")
sugar_wheel_direct_methods = [
    "_init", "is_actions_playback_locked", "get_debug_visual_state", "_sugar_dbg", "_sugar_sfx",
    "_mark_charge_pointer_down", "_mark_charge_pointer_released", "_mark_charge_pointer_canceled",
    "_layout_action_input_shield", "_refresh_wheel_layer_interactivity", "_on_actions_lock_changed",
    "_run_sugar_wheel_action_batch", "load", "_make_button", "_make_circular_charge_button",
    "_charge_button_diameter", "_paint_charge_button_disk", "_make_close_icon_button",
    "_make_debug_speech_test_button", "_collect_speech_debug_roles", "_sort_debug_speech_roles",
    "_rebuild_speech_debug_buttons", "_layout_speech_debug_panel", "_paint_button", "_layout",
    "_paint_arc_charge_ring", "_layout_result_banner", "_clear_result_banner_immediate",
    "_start_result_banner_anim", "_advance_result_banner", "_layout_confirm", "_before_charge_passed",
    "_process_charge_input", "_process_charge_release", "_release_charge", "_launch_after_charge_pass_actions",
    "_enter_charge_phase", "_pointer_art_offset_rad", "_sector_layout", "_sector_index_from_wheel_geom_angle",
    "_wheel_geom_angle_mod", "_begin_physics_spin", "_finish_spin", "abort", "_request_close", "_cancel_charge",
    "_accept_close", "_dismiss_close", "update", "_normalize_pointer_rotation_snapped", "_maybe_play_spin_tick",
    "reset_pointer_geom_angle_deg", "show_speech", "dismiss_speech", "dismiss_all_speech",
    "_remove_speech_entry_at", "_update_speech_bubbles", "_resolve_speech_anchor", "_build_speech_bubble_node",
    "destroy", "_begin_pointer_drag", "_update_pointer_drag", "_end_pointer_drag",
    "_after_pointer_drag_release_actions", "_sector_action_list", "_with_sugar_wheel_debug_probe",
    "_rotate_pointer_toward_event", "_geom_point_on_wheel", "toggle_geom_debug_overlay",
    "_refresh_geom_debug_layer", "_current_power",
]
require(sugar_wheel_scene_methods[:len(sugar_wheel_direct_methods)] == sugar_wheel_direct_methods,
        f"Godot SugarWheelMinigameScene direct method architecture/order drift: {sugar_wheel_scene_methods[:len(sugar_wheel_direct_methods)]}")
for forbidden_sugar_scene_api in [
    r"^var art_stack\b", r"^var background\b", r"^var foreground\b", r"^var wheel_overlay\b",
    r"^var result_label\b", r"^var close_button\b", r"^var hint_label\b", r"^var _destroyed\b",
    r"^func get_root\(", r"^func get_phase\(", r"^func get_spin_omega\(", r"^func get_instance\(",
    r"^func get_last_result\(", r"^func get_speech_count\(", r"^func is_confirm_visible\(",
    r"^func debug_drag_pointer\(", r"^func debug_press_charge\(", r"^func debug_release_charge\(",
    r"^func debug_spin_to_completion\(", r"^func debug_accept_close\(", r"^func _action_list\(",
]:
    require(re.search(forbidden_sugar_scene_api, gd_sugar_wheel_scene, flags=re.MULTILINE) is None,
            f"Godot SugarWheelMinigameScene retains target-owned shell API: {forbidden_sugar_scene_api}")
require("instance = next_instance" in gd_function(gd_sugar_wheel_scene, "load")
        and "instance = next_instance.duplicate" not in gd_function(gd_sugar_wheel_scene, "load"),
        "Godot SugarWheelMinigameScene loses source instance object identity")
require("advance_sugar_wheel_spin_step({" in gd_sugar_wheel_scene
        and all(token in gd_sugar_wheel_scene for token in [
            '"instance": instance', '"omega": spin_omega', '"alpha": spin_alpha',
            '"phiGeom": geometry_angle', '"dt": step',
            "sector_layout_from_instance(instance)", "sector_index_from_wheel_geom_angle(",
        ]), "Godot SugarWheelMinigameScene bypasses direct spin-physics object/API boundaries")
require(ordered_tokens(gd_function(gd_sugar_wheel_scene, "update"), [
    "_advance_result_banner()", "_update_speech_bubbles()", "_process_charge_input()",
    'phase == "charging"', "charge_elapsed += dt", "_process_charge_release()", "_paint_arc_charge_ring()",
    "minf(maxf(dt, 0.0), 0.05)", 'phase != "spinning"', "atmosphere_scheduler.tick(step)",
    "advance_sugar_wheel_spin_step({", "spin_omega = output.omega", "spin_alpha = output.alpha",
    "pointer_sprite.rotation = output.phiGeom + art", "_maybe_play_spin_tick()", "spin_settle_accum += step",
    "pointer_sprite.rotation = _normalize_pointer_rotation_snapped()", "_finish_spin()",
    "resolve_atmosphere_phase(phase, absf(spin_omega))", "atmosphere_scheduler.tick(step)",
]), "Godot SugarWheelMinigameScene update/physics/atmosphere order drift")
require(ordered_tokens(gd_function(gd_sugar_wheel_scene, "_finish_spin"), [
    '_sector_index_from_wheel_geom_angle(geometry_angle)', '"sectorPayload": sector.get("payload")',
    'phase = "landing"', "spin_omega = 0.0", "spin_alpha = 0.0", "_sector_action_list",
    "_with_sugar_wheel_debug_probe", "_finish_spin_after_landing_actions_adapter",
]), "Godot SugarWheelMinigameScene landing result/action order drift")
require("sector_layout_from_instance(instance)" in gd_sugar_wheel_atmosphere,
        "Godot sugarWheelAtmosphere bypasses direct sector layout API")

require(ordered_tokens(ts_sugar_wheel_atmosphere, [
    "export interface SugarWheelAtmosphereHost", "function sugarWheelOpcodes(",
    "say(step, ctx)", "when_near_sector(step, ctx, runChildren)",
    "const SLOWING_OMEGA_THRESHOLD", "export class SugarWheelAtmosphereScheduler",
    "private group", "private runner", "private ctx", "private currentPhase", "private pendingPhase",
    "private host", "private rng", "constructor(", "selectGroup(", "notifyPhase(", "tick(",
    "cancel()", "private startPhase(", "static resolveAtmospherePhase(", "function weightedPick",
]), "TypeScript sugarWheelAtmosphere module/class architecture drift")
sugar_atmosphere_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_atmosphere, flags=re.MULTILINE)
sugar_atmosphere_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_sugar_wheel_atmosphere, flags=re.MULTILINE)
require(sugar_atmosphere_fields == [
    "group", "runner", "ctx", "current_phase", "pending_phase", "host", "rng",
], f"Godot sugarWheelAtmosphere field architecture/order drift: {sugar_atmosphere_fields}")
require(sugar_atmosphere_methods == [
    "_sugar_wheel_opcodes", "_init", "select_group", "notify_phase", "tick", "cancel",
    "_start_phase", "resolve_atmosphere_phase", "_weighted_pick",
], f"Godot sugarWheelAtmosphere module/method architecture/order drift: {sugar_atmosphere_methods}")
for forbidden_sugar_atmosphere_api in [
    "_injected_rng", "_random_state", "func _say(", "func _when_near_sector(",
    "func _pick_text(", "func _seed_random(", "func _next_random(",
    "func _init(next_host: Dictionary, rng:", "clampi(int(floor(",
]:
    require(forbidden_sugar_atmosphere_api not in gd_sugar_wheel_atmosphere,
            f"Godot sugarWheelAtmosphere retains target-owned RNG/opcode API: {forbidden_sugar_atmosphere_api}")
sugar_opcodes = gd_function(gd_sugar_wheel_atmosphere, "_sugar_wheel_opcodes")
require(ordered_tokens(sugar_opcodes, [
    '"say": func(', 'step.get("role")', 'else "child_a"', 'step.get("text")',
    'step.get("pool")', "opcode_ctx.vars.get", "values is Array and not values.is_empty()",
    "floor(float(random.call()) * values.size())", 'step.get("slot")', 'else "_line"',
    "opcode_ctx.slots.get(slot)", "if not text.is_empty():", "opcode_host.showSpeech",
    'show_speech.call(role, text, step.get("durationMs"))', '"when_near_sector": func(',
    'step.get("sectorId")', 'step.get("degBuffer")', "maxf(0.0,", "opcode_host.getInstance",
    "sector_layout_from_instance(instance)", "for index: int in instance.sectors.size():",
    "instance.sectors[index].id == sector_id", "if sector_index < 0:",
    "opcode_host.getWheelGeomAngleMod", "var difference := phi - center",
    "floor(difference / RuntimeSugarWheelSpinPhysics.TAU + 0.5)",
    "absf(difference) * (180.0 / PI) <= buffer_degrees", 'step.get("then")',
    "in_range and then_steps is Array and not then_steps.is_empty()", 'step.get("else")',
    "not in_range and else_steps is Array and not else_steps.is_empty()",
]), "Godot sugarWheelAtmosphere say/near-sector opcode fallback/branch topology drift")
sugar_select_group = gd_function(gd_sugar_wheel_atmosphere, "select_group")
require(ordered_tokens(sugar_select_group, [
    "cancel()", 'instance.get("atmosphereGroups")', "not groups is Array or groups.is_empty()",
    "group = null", "RuntimeDeterministicRandom.create_deterministic_random(str(instance.id))",
    "group = _weighted_pick(groups", 'value.get("weight")', "maxf(0.0,",
    'group.get("vars")', '"rng": rng', '"vars": raw_vars.duplicate(false)', '"slots": {}',
    "RuntimeMinigameScriptRunner.core_opcodes()", "registry.merge(_sugar_wheel_opcodes(host), true)",
    "runner = RuntimeMinigameScriptRunner.new(registry, ctx)", "current_phase = null",
]) and "duplicate(true)" not in sugar_select_group,
        "Godot sugarWheelAtmosphere group selection/shared RNG/shallow context topology drift")
sugar_notify_phase = gd_function(gd_sugar_wheel_atmosphere, "notify_phase")
sugar_atmosphere_tick = gd_function(gd_sugar_wheel_atmosphere, "tick")
sugar_atmosphere_cancel = gd_function(gd_sugar_wheel_atmosphere, "cancel")
sugar_start_phase = gd_function(gd_sugar_wheel_atmosphere, "_start_phase")
require(ordered_tokens(sugar_notify_phase, [
    "phase == current_phase", 'phase == "spinning"', 'current_phase == "start"',
    "runner != null and runner.is_running()", 'pending_phase = "spinning"', "pending_phase = null",
    "_start_phase(phase)",
]), "Godot sugarWheelAtmosphere start-vs-spinning pending priority drift")
require(ordered_tokens(sugar_atmosphere_tick, [
    "runner.tick(dt)", "pending_phase != null", "not runner.is_running()",
    "var next: String = pending_phase", "pending_phase = null", "_start_phase(next)",
]), "Godot sugarWheelAtmosphere pending continuation tick order drift")
require(ordered_tokens(sugar_atmosphere_cancel, [
    "runner.cancel()", "current_phase = null", "pending_phase = null",
]), "Godot sugarWheelAtmosphere cancel state ownership drift")
require(ordered_tokens(sugar_start_phase, [
    "current_phase = phase", "not group is Dictionary or runner == null", "group.get(phase)",
    "steps is Array and not steps.is_empty()", "runner.run_phase(steps)",
]), "Godot sugarWheelAtmosphere startPhase current-state/runner order drift")
sugar_weighted_pick = gd_function(gd_sugar_wheel_atmosphere, "_weighted_pick")
require(ordered_tokens(sugar_weighted_pick, [
    "var total := 0.0", "for item: Variant in items:", "total += float(weight_fn.call(item))",
    "if total <= 0.0:", "return items[0]", "float(random.call()) * total",
    "remaining -= float(weight_fn.call(item))", "if remaining <= 0.0:", "return item",
    "return items[-1]",
]), "Godot sugarWheelAtmosphere weightedPick evaluation/RNG/subtraction order drift")
sugar_wheel_constructor = gd_function(gd_sugar_wheel_scene, "_init")
require(ordered_tokens(sugar_wheel_constructor, [
    '"showSpeech": Callable(self, "show_speech")',
    '"getWheelGeomAngleMod": Callable(self, "_wheel_geom_angle_mod")',
    '"getSpinOmega": func()', '"getInstance": func()',
    "RuntimeSugarWheelAtmosphereScheduler.new(atmosphere_host)",
    "RuntimeMinigameActionPlaybackGate.new(",
]) and "injected_rng" not in sugar_wheel_constructor and "Callable(), Callable()" not in sugar_wheel_constructor,
        "Godot SugarWheelMinigameScene atmosphere host/dependency boundary drift")

require(ordered_tokens(ts_water_manager, [
    "protected readonly indexUrl", "protected readonly dataSubdir", "protected readonly scopePrefix",
    "protected readonly systemLabel", "private flagStore", "private actionExecutor", "private dayManager",
    "private resolveTextFn", "private pendingUseKey", "private sessionDegraded", "private sessionUseKey",
    "private usesBySpotDay", "private consumedPullEntities", "private sessionPullSpaceHeld",
    "private boundPullSpaceKeyDown", "private boundPullSpaceKeyUp", "private boundPullWindowBlur",
    "init(ctx", "bindRuntime(", "protected runtimeReady", "serialize()", "getDebugVisualState",
    "deserialize(", "destroy()", "protected prepareInstance", "protected onSessionActive",
    "protected createScene", "protected loadSceneContent", "protected onSceneLoaded", "protected tickScene",
    "protected onTeardown", "protected buildInstanceManifestRefs", "private markConsumed",
    "private attachSessionPullSpaceBridge", "private detachSessionPullSpaceBridge",
]), "TypeScript WaterMinigameManager field/method architecture drift")
water_manager_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_water_manager, flags=re.MULTILINE)
water_manager_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_water_manager, flags=re.MULTILINE)
require(water_manager_fields == [
    "flag_store", "action_executor", "day_manager", "resolve_text_fn", "pending_use_key", "session_degraded",
    "session_use_key", "uses_by_spot_day", "consumed_pull_entities", "session_pull_space_held",
    "bound_pull_space_key_down", "bound_pull_space_key_up", "bound_pull_window_blur",
], f"Godot WaterMinigameManager field architecture/order drift: {water_manager_fields}")
require(water_manager_methods == [
    "_init", "init", "bind_runtime", "runtime_ready", "serialize", "get_debug_visual_state", "deserialize",
    "destroy", "prepare_instance", "on_session_active", "create_scene", "load_scene_content", "on_scene_loaded",
    "tick_scene", "on_teardown", "build_instance_manifest_refs", "_mark_consumed",
    "_attach_session_pull_space_bridge", "_detach_session_pull_space_bridge", "_input", "_notification",
], f"Godot WaterMinigameManager method architecture/order drift: {water_manager_methods}")
require(ordered_tokens(gd_function(gd_water_manager, "_init"), [
    "index_url = INDEX_URL", 'data_subdir = "water_minigames"', 'scope_prefix = "minigame:water"',
    'system_label = "WaterMinigameManager"', "set_process_input(false)",
]), "Godot WaterMinigameManager abstract-property/platform initialization drift")
require(ordered_tokens(gd_function(gd_water_manager, "bind_runtime"), [
    'renderer = deps.get("renderer")', 'input_manager = deps.get("inputManager")',
    'state_controller = deps.get("stateController")', 'action_executor = deps.get("actionExecutor")',
    'day_manager = deps.get("dayManager")', 'resolve_text_fn = deps.get("resolveDisplayText")',
]), "Godot WaterMinigameManager runtime dependency ownership/order drift")
water_prepare = gd_function(gd_water_manager, "prepare_instance")
require(ordered_tokens(water_prepare, [
    "original.duplicate(false)", "for entity: Variant in original.entities", "entities.push_back(entity)",
    'prepared.get("spotId")', "if spot == null", "day_manager.get_current_day()", "flag_store.get_value",
    "is_finite(float(day_raw))", 'var key := "%s|%s"', "session_use_key = key", "session_degraded =",
]) and "duplicate(true)" not in water_prepare and "day <= 0" not in water_prepare,
        "Godot WaterMinigameManager prepareInstance identity/day/nullish semantics drift")
require(ordered_tokens(gd_function(gd_water_manager, "create_scene"), [
    "RuntimeWaterMinigameScene.new(", "session_pull_space_held", "input_manager.is_mouse_down()",
    "teardown_session()", "_mark_consumed(str(next_instance.id), entity_id)", "restore_minigame_state_after_action",
]), "Godot WaterMinigameManager scene callback ownership drift")
water_teardown = gd_function(gd_water_manager, "on_teardown")
require(ordered_tokens(water_teardown, [
    "_detach_session_pull_space_bridge()", "pending_use_key is String", "var key: String = pending_use_key",
    "pending_use_key = null", "uses_by_spot_day[key] =",
]), "Godot WaterMinigameManager quota teardown order/truthiness drift")
water_manifest = gd_function(gd_water_manager, "build_instance_manifest_refs")
require(ordered_tokens(water_manifest, [
    'next_instance.get("waterBottom")', '"水域底图: %s"', 'next_instance.get("shoreForeground")',
    "for bank: Variant in banks", 'bank.get("sprite")', "for entity: Variant in next_instance.entities",
    'entity.get("sprite")',
]) and "str(path)" not in water_manifest, "Godot WaterMinigameManager manifest/null-path semantics drift")
water_attach = gd_function(gd_water_manager, "_attach_session_pull_space_bridge")
water_detach = gd_function(gd_water_manager, "_detach_session_pull_space_bridge")
require(ordered_tokens(water_attach, [
    "_detach_session_pull_space_bridge()", "session_pull_space_held = false", "bound_pull_space_key_down = func",
    "not active", "get_viewport().set_input_as_handled()", "session_pull_space_held = true",
    "bound_pull_space_key_up = func", "session_pull_space_held = false", "bound_pull_window_blur = func",
    "session_pull_space_held = false", "set_process_input(true)",
]), "Godot WaterMinigameManager three-listener attach ownership/order drift")
require(ordered_tokens(water_detach, [
    "bound_pull_space_key_down = null", "bound_pull_space_key_up = null", "bound_pull_window_blur = null",
    "set_process_input(false)", "session_pull_space_held = false",
]), "Godot WaterMinigameManager three-listener detach ownership/order drift")
for forbidden_water_api in ["get_use_count", "is_entity_consumed", "is_session_degraded", "_pull_space_bridge_attached", "_on_scene_finish", "_is_pull_held"]:
    require(forbidden_water_api not in gd_water_manager, f"Godot WaterMinigameManager retains target-only API/state: {forbidden_water_api}")

require(ordered_tokens(ts_water_entity, [
    "export type WaterAmbient", "function parseHexColor(", "export type WaterEntityCreateOptions",
    "const DEFAULT_DISPLAY_SIZE", "const DEFAULT_HIT_RADIUS", "export class WaterEntity",
    "readonly def", "readonly category", "readonly sprite", "readonly container", "paramsSprite?",
    "private motionT", "private depthPhase", "private random", "private patrolDir", "private startX",
    "private startY", "private fleeBursts", "private escaped", "private fleeDeadlineMs",
    "private paramEncode", "constructor(", "hitRadius()", "private glowStrength()", "setFleeDeadline(",
    "isEscaped()", "get depthOffsetY", "get effectiveDepth", "reactGrass(", "private applyTint(",
    "update(dt", "onPointerTap(", "destroy()", "export async function loadEntityTexture",
]), "TypeScript WaterEntity module/field/method architecture drift")
water_entity_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_water_entity, flags=re.MULTILINE)
water_entity_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_water_entity, flags=re.MULTILINE)
require(water_entity_fields == [
    "def", "category", "sprite", "container", "params_sprite", "motion_t", "depth_phase", "random",
    "patrol_dir", "start_x", "start_y", "flee_bursts", "escaped", "flee_deadline_ms", "param_encode",
    "params_container", "_pointer_tap_callbacks",
], f"Godot WaterEntity direct/engine-adapter field architecture/order drift: {water_entity_fields}")
require(water_entity_methods == [
    "_parse_hex_color", "_init", "hit_radius", "_glow_strength", "set_flee_deadline", "is_escaped",
    "depth_offset_y", "effective_depth", "react_grass", "_apply_tint", "update", "on_pointer_tap",
    "_emit_pointer_tap", "destroy", "load_entity_texture",
], f"Godot WaterEntity module/method/engine-adapter order drift: {water_entity_methods}")
for forbidden_water_entity_api in [
    "motion_time", "var rng", "patrol_direction", "start_position", "param_material",
    "random_provider", "encode_params", "func is_visible(", "func set_visible(", "func hit_center(",
    "func react_grass()", "maxf(0.0, dt)", "Color.from_string", "_packed_channel",
]:
    require(forbidden_water_entity_api not in gd_water_entity,
            f"Godot WaterEntity retains flattened/non-source API or behavior: {forbidden_water_entity_api}")
water_entity_parse = gd_function(gd_water_entity, "_parse_hex_color")
require(ordered_tokens(water_entity_parse, [
    "value.strip_edges()", 'begins_with("#")', "text.substr(1)", "hex.length() == 3",
    "character + character", "full.strip_edges(true, false)", 'begins_with("-")', 'begins_with("+")',
    'full.substr(index, 2).to_lower() == "0x"', 'digits := "0123456789abcdef"',
    "digits.find(", "if digit < 0:", "if not is_finite(number):", "if not parsed:",
    "fposmod(number, 4294967296.0)", '"r":', '"g":', '"b":',
]), "Godot WaterEntity parseHexColor parseInt/ToUint32 translation drift")
water_entity_init = gd_function(gd_water_entity, "_init")
require(ordered_tokens(water_entity_init, [
    "def = definition", "category = str(def.category)", 'options.get("random")',
    "provided_random is Callable", "else func() -> float: return randf()", "float(random.call()) * PI * 2.0",
    "start_x = float(def.pos.x)", "start_y = float(def.pos.y)", "container = Node2D.new()",
    "Vector2(start_x, start_y)", "sprite = Sprite2D.new()", "sprite.texture = texture",
    "maxf(texture.get_width(), texture.get_height())", 'def.get("displaySize")', "is_finite(float(display_size))",
    "float(display_size) > 0.0", "DEFAULT_DISPLAY_SIZE.get(category, 52.0)",
    'options.get("paramsEncode") == true', "ShaderMaterial.new()", "params_sprite = Sprite2D.new()",
    "params_sprite.material = param_encode", "container.add_child(sprite)", "params_container = Node2D.new()",
    "params_container.position = container.position", "params_container.add_child(params_sprite)", "_apply_tint()",
]) and "duplicate(" not in water_entity_init,
        "Godot WaterEntity constructor identity/options/RNG/geometry/params-pass order drift")
require(ordered_tokens(gd_function(gd_water_entity, "hit_radius"), [
    'def.get("hitRadius")', "is_finite(float(radius))", "float(radius) > 0.0",
    "DEFAULT_HIT_RADIUS.get(category, 30.0)",
]), "Godot WaterEntity hitRadius finite-positive/default contract drift")
require(ordered_tokens(gd_function(gd_water_entity, "_glow_strength"), [
    'def.get("glow")', 'glow.get("enabled") != true', "return 0.0", 'glow.get("daylightHint")',
    "minf(1.0, maxf(0.0", "else 0.45",
]), "Godot WaterEntity glowStrength default/clamp contract drift")
require(ordered_tokens(gd_function(gd_water_entity, "set_flee_deadline"), [
    'def.get("motion")', 'motion.get("path") == "flee"', 'category == "swimming"',
    "maxf(0.25, total_search_sec - 1.0)", "flee_deadline_ms = lead_sec * 1000.0",
]), "Godot WaterEntity flee-deadline contract drift")
require(ordered_tokens(gd_function(gd_water_entity, "effective_depth"), [
    'maxf(0.0, float(def.get("depth", 0.0)))', 'def.get("depthOsc")',
    'oscillation.get("curve") == "none"', 'float(oscillation.get("amplitude", 0.0)) == 0.0',
    'maxf(0.15, float(oscillation.get("period", 0.0)))', 'oscillation.get("curve") == "sine"',
    "sin(depth_phase + motion_t / period * PI * 2.0)", 'oscillation.get("curve") == "approach_surface"',
    "sin(motion_t / period) * 0.5 + 0.5", "addition = -t", "else:",
    "sin(motion_t * 3.1 + depth_phase) * 0.5", "maxf(0.0, base + addition)",
]), "Godot WaterEntity effectiveDepth branch/formula contract drift")
require(ordered_tokens(gd_function(gd_water_entity, "_apply_tint"), [
    "minf(effective_depth(), 1.0)", "var murk := 0.35", 'ambient.get("weather") == "rain"',
    "murk = 0.55", 'ambient.get("weather") == "fog"', "murk = 0.8",
    "1.1 - depth_visual * 0.55 - murk * 0.35", "_parse_hex_color(glow_color_value)",
    "float(raw_hint) if raw_hint != null else 0.4", "red = red * (1.0 - hint)",
    'ambient.get("time") == "night"', "red *= 0.55", "green *= 0.6", "blue *= 0.75",
    'ambient.get("time") == "morning"', "red *= 1.05", "green *= 0.97", "blue *= 0.9",
    "floorf(red * 255.0 + 0.5)", "& 255", "floorf(green * 255.0 + 0.5)",
    "floorf(blue * 255.0 + 0.5)",
]), "Godot WaterEntity tint/murk/glow/unclamped-hint/JS-round-pack contract drift")
water_entity_update = gd_function(gd_water_entity, "update")
require(ordered_tokens(water_entity_update, [
    "if escaped:", "motion_t += dt", "flee_deadline_ms != null", "motion_t * 1000.0 >=",
    "escaped = true", "container.visible = false", "params_sprite.visible = false", "params_container.visible = false",
    'motion.get("speed", 0.0)', 'motion.get("jitter", 0.0)', 'category == "swimming"',
    'motion.get("path") == "drift"', "sin(motion_t * 0.7 + depth_phase) * speed * dt * 12.0",
    "cos(motion_t * 0.55) * speed * dt * 8.0", 'motion.get("path") == "patrol"',
    "patrol_dir * speed * dt * 35.0", "start_x + 90.0", "patrol_dir = -1.0", "start_x - 90.0",
    "patrol_dir = 1.0", 'motion.get("path") == "approach"', "sqrt(dx * dx + dy * dy) + 1e-4",
    "dx / length * speed * dt * 40.0", 'motion.get("path") == "flee"', "flee_bursts += dt",
    "18.0 + flee_bursts * 4.0", "if jitter > 0.0:", "float(random.call()) - 0.5",
    'category == "floating"', "sin(motion_t * 0.4) * dt * 6.0", "cos(motion_t * 0.35) * dt * 4.0",
    "sprite.position.y = depth_offset_y()", "params_container.position = container.position",
    "params_sprite.rotation = sprite.rotation", "params_sprite.scale = sprite.scale",
    'set_shader_parameter("depth_value"', 'set_shader_parameter("glow_value"', "_apply_tint(ambient)",
]), "Godot WaterEntity update motion/RNG/param-pass operation order drift")
require(ordered_tokens(gd_function(gd_water_entity, "on_pointer_tap"), [
    "callback.is_valid()", "_pointer_tap_callbacks.push_back(callback)",
]) and ordered_tokens(gd_function(gd_water_entity, "_emit_pointer_tap"), [
    "if escaped:", "for callback: Callable in _pointer_tap_callbacks.duplicate()", "callback.call(self, event)",
]), "Godot WaterEntity pointertap adapter contract drift")
require(ordered_tokens(gd_function(gd_water_entity, "destroy"), [
    "_pointer_tap_callbacks.clear()", "params_sprite.material = null", "param_encode = null",
]), "Godot WaterEntity destroy/listener/filter ownership drift")
require(ordered_tokens(gd_function(gd_water_entity, "load_entity_texture"), [
    'path.substr(1) if path.begins_with("/") else path', "asset_manager.load_texture(normalized)",
    "await RuntimeMicrotaskQueueScript.yield_turn()", "if texture is Texture2D:", "return texture",
    "if _texture_white == null:", "Image.create_empty(1, 1", "image.fill(Color.WHITE)",
    "_texture_white = ImageTexture.create_from_image(image)", "return _texture_white",
]) and "static var _texture_white: Texture2D" in gd_water_entity,
        "Godot WaterEntity loadEntityTexture normalize/await/Texture.WHITE-singleton contract drift")

require(ordered_tokens(ts_water_pull_panel, [
    "export type PullPanelResult", "export interface WaterPullPanelParams", "export class WaterPullPanel",
    "private progress", "private marker", "private markerVel", "private greenCenter",
    "private liftHeldBinding", "private elapsed", "private readonly limit", "private done",
    "private burstTelegraph", "private spasmNextAt", "private spasmKick", "private wobbleSeed",
    "private readonly random", "private readonly barW", "private readonly barH", "private barG",
    "private warningG", "private markerG", "private greenG", "private progG", "private hint",
    "constructor(private params", "setLiftHeld(", "private liftHeld(", "private resetMarkerForRhythm(",
    "private refreshGeometry(", "private markerWobble(", "private smooth01(", "private lerp(",
    "private driveGreen(", "private driveMarker(", "private inZone(", "update(dt", "abort()",
    "private finish(",
]), "TypeScript WaterPullPanel field/method architecture drift")
water_pull_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_water_pull_panel, flags=re.MULTILINE)
water_pull_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_water_pull_panel, flags=re.MULTILINE)
require(water_pull_fields == [
    "progress", "marker", "marker_vel", "green_center", "lift_held_binding", "elapsed", "limit", "done",
    "burst_telegraph", "spasm_next_at", "spasm_kick", "wobble_seed", "random", "bar_w", "bar_h",
    "bar_g", "warning_g", "marker_g", "green_g", "prog_g", "hint", "params",
], f"Godot WaterPullPanel field architecture/order drift: {water_pull_fields}")
require(water_pull_methods == [
    "_init", "set_lift_held", "_lift_held", "_reset_marker_for_rhythm", "_refresh_geometry",
    "_marker_wobble", "_smooth01", "_lerp", "_drive_green", "_drive_marker", "_in_zone", "update",
    "abort", "_finish", "_draw_bar", "_draw_warning", "_draw_green", "_draw_marker", "_draw_progress",
], f"Godot WaterPullPanel method/engine-adapter order drift: {water_pull_methods}")
for forbidden_water_pull_api in [
    "random_provider", "var rng", "var marker_velocity", "var lift_held :=", "var time_limit",
    "func is_done(", "func get_progress(", "func get_marker(", "func get_green_center(",
    "func debug_finish(", "func debug_set_state(", "func _smooth_lerp(", "func _text(",
]:
    require(forbidden_water_pull_api not in gd_water_pull_panel,
            f"Godot WaterPullPanel retains flattened/test-only API/state: {forbidden_water_pull_api}")
water_pull_init = gd_function(gd_water_pull_panel, "_init")
require(ordered_tokens(water_pull_init, [
    "params = initial_params", 'params.get("random")', "provided_random is Callable",
    "else func() -> float: return randf()", "float(random.call()) * PI * 2.0",
    "maxf(2.0, float(params.timeLimitSec))", "_reset_marker_for_rhythm()",
    'GraphicsLayer.new(Callable(self, "_draw_bar"))', 'GraphicsLayer.new(Callable(self, "_draw_warning"))',
    'GraphicsLayer.new(Callable(self, "_draw_green"))', 'GraphicsLayer.new(Callable(self, "_draw_marker"))',
    'GraphicsLayer.new(Callable(self, "_draw_progress"))', "hint = Label.new()",
    "hint.position.y = bar_h + 12.0", "for child: Control in [bar_g, warning_g, green_g, marker_g, prog_g, hint]",
    "add_child(child)", "_refresh_geometry()",
]), "Godot WaterPullPanel constructor RNG/field/child/refresh order drift")
water_pull_reset = gd_function(gd_water_pull_panel, "_reset_marker_for_rhythm")
require(ordered_tokens(water_pull_reset, [
    'params.rhythm == "heavy_sink"', "green_center = 0.72", "marker = 0.7",
    'params.rhythm == "burst"', "green_center = 0.35", "marker = 0.38",
    "green_center = 0.5", "marker = 0.5", "marker_vel = 0.0",
    "spasm_next_at = 0.65 + float(random.call()) * 0.85",
]), "Godot WaterPullPanel rhythm reset/RNG order drift")
water_pull_refresh = gd_function(gd_water_pull_panel, "_refresh_geometry")
require(ordered_tokens(water_pull_refresh, [
    "bar_g.queue_redraw()", "warning_g.queue_redraw()", "green_g.queue_redraw()",
    "marker_g.queue_redraw()", "prog_g.queue_redraw()",
]), "Godot WaterPullPanel five-Graphics refresh ownership/order drift")
water_pull_wobble = gd_function(gd_water_pull_panel, "_marker_wobble")
require(ordered_tokens(water_pull_wobble, [
    'params.rhythm == "heavy_sink"', "return 0.0", 'params.rhythm == "spasm"',
    "sin(elapsed * 19.0 + wobble_seed) * (1.2 + spasm_kick * 9.0)",
    'params.rhythm == "burst"', "sin(elapsed * 10.0 + wobble_seed) * (0.6 + burst_telegraph * 3.4)",
    "sin(elapsed * 3.2 + wobble_seed) * 0.8",
]), "Godot WaterPullPanel marker wobble formulas drift")
water_pull_green = gd_function(gd_water_pull_panel, "_drive_green")
require(ordered_tokens(water_pull_green, [
    "var t := elapsed", "var rhythm: String = params.rhythm", "float(params.zoneSize)",
    "burst_telegraph = 0.0", "spasm_kick = maxf(0.0, spasm_kick - dt * 2.8)",
    'rhythm == "stable"', "0.5 + sin(t * 2.2) * (0.42 - half_zone)", 'rhythm == "burst"',
    "fposmod(t, 4.2)", "cycle < 2.45", "0.35 + sin(t * 3.2) * 0.035", "cycle < 3.15",
    "burst_telegraph = (cycle - 2.45) / 0.7", "_lerp(0.35, 0.56, burst_telegraph)",
    "cycle < 3.55", "burst_telegraph = 1.0", "0.78 + sin(t * 8.0) * 0.025",
    "_lerp(0.78, 0.35, (cycle - 3.55) / 0.65)", 'rhythm == "spasm"',
    "t >= spasm_next_at", "0.18 + float(random.call()) * 0.64",
    "marker_vel -= (0.16 + float(random.call()) * 0.22)", "spasm_kick = 1.0",
    "t + 0.45 + float(random.call()) * 1.35", "sin(t * 11.0 + marker * 7.0) * dt * 0.28",
    "0.72 + sin(t * 0.45) * 0.025", "maxf(half_zone + 0.02, minf(1.0 - half_zone - 0.02, green_center))",
]), "Godot WaterPullPanel green rhythm/RNG/clamp operation order drift")
water_pull_marker = gd_function(gd_water_pull_panel, "_drive_marker")
require(ordered_tokens(water_pull_marker, [
    "maxf(0.2, float(params.sliderSpeed))", "var held := _lift_held()",
    "(1.12 if held else -0.62) * base", 'params.rhythm == "heavy_sink"',
    "(1.38 if held else -0.9) * base", 'params.rhythm == "burst"',
    "1.25 if burst_telegraph > 0.8 else 1.0", 'params.rhythm == "spasm"',
    "1.0 + spasm_kick * 0.25", "marker_vel += acceleration * dt * 2.4",
    "marker_vel *= exp(-dt * (2.1 if held else 2.8))", "0.78 if params.rhythm == \"heavy_sink\" else 0.95",
    "marker_vel = maxf(-max_velocity, minf(max_velocity, marker_vel))", "marker += marker_vel * dt * 1.1",
    "if marker < 0.02:", "marker = 0.02", "marker_vel = maxf(0.0, marker_vel * -0.15)",
    "if marker > 0.98:", "marker = 0.98", "marker_vel = minf(0.0, marker_vel * -0.15)",
]), "Godot WaterPullPanel marker acceleration/damping/clamp/bounce order drift")
water_pull_update = gd_function(gd_water_pull_panel, "update")
require(ordered_tokens(water_pull_update, [
    "if done:", "minf(maxf(dt, 0.0), 0.084)", "elapsed += step", "_drive_green(step)",
    "_drive_marker(step)", "var overlap := _in_zone()", "if overlap:", "var rate := 0.34",
    'params.rhythm == "heavy_sink"', "rate = 0.22", 'params.rhythm == "burst"', "rate = 0.36",
    'params.rhythm == "spasm"', "rate = 0.28", "progress = minf(1.0, progress + rate * step)",
    "var drain := 0.07", "drain = 0.18 if _lift_held() else 0.13",
    "drain = 0.11 + spasm_kick * 0.08", "drain = 0.09 + burst_telegraph * 0.06",
    "progress = maxf(0.0, progress - drain * step)", "maxf(0.0, limit - elapsed)",
    'params.resolveText', '"[tag:string:waterMinigame:%s]"', "pullStateForeshadow",
    "pullStateYank", "pullStateInZone", "pullStateHold", "pullStateRelease", "pullStatus",
    'replace("{sec}", "%.1f" % remaining)', 'replace("{state}", state_hint)', "_refresh_geometry()",
    "if progress >= 0.995:", '_finish("success")', "return", "if elapsed >= limit:",
    'params.failurePolicy == "escape"', '_finish("fail_escape")', 'params.failurePolicy == "snap"',
    '_finish("fail_snap")', '_finish("fail_bite")',
]), "Godot WaterPullPanel update progress/text/success/failure order drift")
require(ordered_tokens(gd_function(gd_water_pull_panel, "_finish"), [
    "if done:", "done = true", "var on_result: Callable = params.onResult", "on_result.call(result)",
]), "Godot WaterPullPanel exactly-once result callback drift")
require(ordered_tokens(ts_water_scene, [
    "export class WaterMinigameScene", "readonly root", "private readonly renderer", "private readonly app",
    "private instance!", "private bottomLayer", "private bottomFill", "private bottomTextureSprite",
    "private waterLayer", "private underwaterRtRoot", "private surfaceLayer", "private shoreLayer",
    "private uiLayer", "private bottomMrt", "private paramsMrt", "private underwaterHitZone",
    "private bottomMrtSprite", "private waterFilter", "private bg", "private shoreSprites",
    "private entities", "private phase", "private pullPanel", "private feedback", "private exitChrome",
    "private time", "private readonly searchHorizonSec", "private unsubResize", "private degraded",
    "private random", "private onFinish", "private onConsumed", "private resolveText",
    "private actionExecutor", "private assetManager", "private getKeyHold", "private readonly actionGate",
    "constructor(", "async load(", "private parseColor(", "private async setupBottomLayer(",
    "private async setupShoreLayer(", "private clamp01(", "private filterDefs(", "private ambient(",
    "private layout(", "private layoutShoreBanks(", "private layoutShoreBank(", "private cursorWorld(",
    "private onUnderwaterPointerTap(", "private prepareUnderwaterPass(", "isActionsPlaybackLocked(",
    "getDebugVisualState(", "private setInputLocked(", "private async runActions(",
    "private showFeedback(", "private clearFeedback(", "private clearExitUi(", "private buildExitUi(",
    "private clearPull(", "private onEntityTap(", "private startPull(", "private async onPullEnd(",
    "abort(", "update(", "destroy(",
]), "TypeScript WaterMinigameScene field/method architecture drift")
water_scene_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_water_scene, flags=re.MULTILINE)
water_scene_methods = re.findall(r"^func ([A-Za-z_][A-Za-z0-9_]*)", gd_water_scene, flags=re.MULTILINE)
require(water_scene_fields == [
    "root", "renderer", "app", "instance", "bottom_layer", "bottom_fill", "bottom_texture_sprite",
    "water_layer", "underwater_rt_root", "surface_layer", "shore_layer", "ui_layer", "bottom_mrt",
    "params_mrt", "underwater_hit_zone", "bottom_mrt_sprite", "water_filter", "bg", "shore_sprites",
    "entities", "phase", "pull_panel", "feedback", "exit_chrome", "time", "search_horizon_sec",
    "unsub_resize", "degraded", "random", "on_finish", "on_consumed", "resolve_text",
    "action_executor", "asset_manager", "get_key_hold", "action_gate",
    # Godot-only rendering/UI adapters follow all direct fields.
    "params_rt_root", "exit_panel", "exit_title", "exit_hint", "bottom_tint",
], f"Godot WaterMinigameScene direct/engine-adapter field architecture/order drift: {water_scene_fields}")
require(water_scene_methods == [
    "_init", "load", "_parse_color", "_setup_bottom_layer", "_setup_shore_layer", "_clamp01",
    "_filter_defs", "_ambient", "_layout", "_layout_shore_banks", "_layout_shore_bank",
    "_cursor_world", "_on_underwater_pointer_tap", "_prepare_underwater_pass",
    "is_actions_playback_locked", "get_debug_visual_state", "_set_input_locked", "_run_actions",
    "_show_feedback", "_clear_feedback", "_clear_exit_ui", "_build_exit_ui", "_clear_pull",
    "_on_entity_tap", "_start_pull", "_on_pull_end", "abort", "update", "destroy",
    # Godot-only engine adapters follow every direct method.
    "_on_pointer_input", "_floating_sprite_contains", "_run_floating_pick",
    "_release_entities_for_reload", "_remove_all_children", "_set_entity_visible",
    "_restore_separate_pass_visibility", "_water_filter_set_time", "_water_filter_apply_surface",
    "_water_filter_set_water_bottom_depth", "_water_filter_debug_uniform_state", "_draw_bottom_fill",
    "_color_from_int", "_resolve_text_value", "_fill_token", "_next_power_of_two",
], f"Godot WaterMinigameScene direct/engine-adapter method architecture/order drift: {water_scene_methods}")
for forbidden_water_scene_api in [
    "var background", "var color_viewport", "var params_viewport", "var color_world", "var params_world",
    "var entity_layer", "var surface_display", "var surface_material", "var active_pull_entity",
    "var elapsed_time", "var _unsubscribe_resize", "var _destroyed", "var _water_scale",
    "var _water_offset", "var _random_state", "func get_root(", "func get_phase(",
    "func get_feedback(", "func is_degraded(", "func get_entity_count(", "func get_visible_entity_ids(",
    "func get_entity(", "func debug_tap_entity(", "func debug_finish_pull(", "func _seed_random(",
    "func _next_random(", "func _action_list(", "func _text(", "get_tree().process_frame",
    "next_instance.duplicate", "maxf(0.0, dt)", "String.replace", "_load_texture_or_white",
    ".is_visible()", ".set_visible(", ".hit_center(", ".react_grass()",
]:
    require(forbidden_water_scene_api not in gd_water_scene,
            f"Godot WaterMinigameScene retains flattened/non-source API or behavior: {forbidden_water_scene_api}")

water_scene_init = gd_function(gd_water_scene, "_init")
require(ordered_tokens(water_scene_init, [
    "renderer = next_renderer", "app = renderer", "asset_manager = next_asset_manager",
    "action_executor = next_action_executor", "resolve_text = next_resolve_text",
    "get_key_hold = next_get_key_hold", "on_finish = next_on_finish",
    "on_consumed = next_on_consumed if next_on_consumed.is_valid() else null",
    "RuntimeMinigameActionPlaybackGate.new(", 'Callable(action_executor, "execute_batch_await")',
    '"onLockChanged": Callable(self, "_set_input_locked")',
    '"restoreMinigameState": restore_minigame_state_after_action', "root = Control.new()",
    "bg = ColorRect.new()", "bottom_layer = Node2D.new()",
    'GraphicsLayer.new(Callable(self, "_draw_bottom_fill"))', "bottom_layer.add_child(bottom_fill)",
    "water_layer = Node2D.new()", "underwater_rt_root = Node2D.new()",
    "underwater_rt_root.add_child(bottom_layer)", "underwater_rt_root.add_child(water_layer)",
    "surface_layer = Node2D.new()", "shore_layer = Node2D.new()", "ui_layer = Control.new()",
    "bottom_mrt = SubViewport.new()", "bottom_mrt.size = Vector2i(4, 4)",
    "bottom_mrt.add_child(underwater_rt_root)", "params_mrt = SubViewport.new()",
    "params_mrt.size = Vector2i(4, 4)", "params_rt_root = Node2D.new()",
    "params_mrt.add_child(params_rt_root)", "bottom_mrt_sprite = TextureRect.new()",
    "bottom_mrt_sprite.texture = bottom_mrt.get_texture()", "water_filter = ShaderMaterial.new()",
    "water_filter.shader = SURFACE_SHADER", 'set_shader_parameter("params_texture", params_mrt.get_texture())',
    "bottom_mrt_sprite.material = water_filter", "underwater_hit_zone = Control.new()",
    'gui_input.connect(Callable(self, "_on_pointer_input"))', "root.add_child(bottom_mrt)",
    "root.add_child(params_mrt)", "root.add_child(bg)", "root.add_child(bottom_mrt_sprite)",
    "root.add_child(underwater_hit_zone)", "root.add_child(surface_layer)",
    "root.add_child(shore_layer)", "root.add_child(ui_layer)",
]), "Godot WaterMinigameScene constructor dependency/gate/tree architecture drift")

water_scene_load = gd_function(gd_water_scene, "load")
require(ordered_tokens(water_scene_load, [
    "instance = next_instance", "RuntimeDeterministicRandom.create_deterministic_random(str(instance.id))",
    "degraded = options.degraded", "time = 0.0", "phase = SEARCH", "_release_entities_for_reload()",
    "entities = []", "_clear_pull()", "_clear_feedback()", "_clear_exit_ui()",
    '_water_filter_apply_surface(str(instance.surface.time), str(instance.surface.weather))',
    'instance.get("waterBottom")', 'water_bottom.get("depth")', "maxf(0.0, float(raw_depth))",
    "is_finite(float(raw_depth))", "else 1.0", "_water_filter_set_water_bottom_depth(water_bottom_depth)",
    "await _setup_bottom_layer()", "await _setup_shore_layer()", "_remove_all_children(water_layer)",
    "_remove_all_children(params_rt_root)", "_remove_all_children(surface_layer)",
    "var definitions := _filter_defs(instance.entities)", "for definition: Dictionary in definitions:",
    "await RuntimeWaterEntity.load_entity_texture(asset_manager, str(definition.sprite))",
    "RuntimeWaterEntity.new(", "definition,", "texture,", "asset_manager,",
    '"paramsEncode": definition.category != "floating"', '"random": random',
    'definition.category == "floating"', "surface_layer.add_child(entity.container)",
    "water_layer.add_child(entity.container)", "params_rt_root.add_child(entity.params_container)",
    "entity.set_flee_deadline(search_horizon_sec)", 'entity.on_pointer_tap(Callable(self, "_on_entity_tap"))',
    "entities.push_back(entity)", "_build_exit_ui()", "_layout()", "unsub_resize.call()",
    'renderer.subscribe_after_resize(Callable(self, "_layout"))',
]) and "duplicate(" not in water_scene_load,
        "Godot WaterMinigameScene load identity/random/filter/layer/entity/resize translation drift")

require(ordered_tokens(gd_function(gd_water_scene, "_parse_color"), [
    "not raw is String", "raw.is_empty()", "raw.strip_edges()", "text.is_empty()",
    'text.substr(1) if text.begins_with("#") else text', "hex.length() == 3", "character + character",
    "full.strip_edges(true, false)", 'full.begins_with("-")', 'full.begins_with("+")',
    'full.substr(index, 2).to_lower() == "0x"', 'digits := "0123456789abcdef"', "digits.find(",
    "if digit < 0:", "if not is_finite(number):", "if not parsed:",
    "fposmod(number * sign, 4294967296.0)",
]), "Godot WaterMinigameScene parseColor parseInt/ToUint32 translation drift")
require(ordered_tokens(gd_function(gd_water_scene, "_setup_bottom_layer"), [
    "bottom_texture_sprite.free()", "bottom_texture_sprite = null", "instance.bounds.width",
    "instance.bounds.height", '_parse_color(instance.get("waterBottom", {}).get("tint"), 0x18324a)',
    "bottom_fill.queue_redraw()", 'instance.get("waterBottom", {}).get("texture")',
    "path_value.strip_edges()", "if texture_path.is_empty():", "await RuntimeMicrotaskQueueScript.yield_turn()",
    'texture_path.substr(1) if texture_path.begins_with("/") else texture_path',
    "asset_manager.load_texture(normalized)", "await RuntimeMicrotaskQueueScript.yield_turn()",
    "if not texture is Texture2D:", "Sprite2D.new()", "sprite.texture = texture",
    "sprite.centered = false", "sprite.position = Vector2.ZERO", "bounds / Vector2(",
    "sprite.modulate.a = 0.9", "bottom_texture_sprite = sprite", "bottom_layer.add_child(sprite)",
]), "Godot WaterMinigameScene bottom graphics/texture/async contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_setup_shore_layer"), [
    "for sprite: Sprite2D in shore_sprites:", "sprite.free()", "shore_sprites = []",
    "_remove_all_children(shore_layer)", '.get("banks", []).slice(0, 2)',
    "for bank: Dictionary in banks:", 'bank.get("sprite")', "path_value.strip_edges()",
    "if texture_path.is_empty():", 'texture_path.substr(1) if texture_path.begins_with("/") else texture_path',
    "asset_manager.load_texture(normalized)", "await RuntimeMicrotaskQueueScript.yield_turn()",
    "if not texture is Texture2D:", "Sprite2D.new()", "sprite.texture = texture",
    "sprite.centered = false", 'bank.get("alpha")', "_clamp01(alpha)",
    "shore_layer.add_child(sprite)", "shore_sprites.push_back(sprite)",
]), "Godot WaterMinigameScene shore load/order/alpha contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_clamp01"), [
    "maxf(0.0, minf(1.0, value))", "is_finite(value)", "else 1.0",
]), "Godot WaterMinigameScene clamp01 finite contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_filter_defs"), [
    "if not degraded:", "return definitions", 'definitions.filter(func(definition: Dictionary) -> bool: return definition.get("valueTier") != "premium")',
]), "Godot WaterMinigameScene filterDefs identity/degraded contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_ambient"), [
    '"time": instance.surface.time', '"weather": instance.surface.weather',
]), "Godot WaterMinigameScene ambient identity contract drift")

water_scene_layout = gd_function(gd_water_scene, "_layout")
require(ordered_tokens(water_scene_layout, [
    "renderer.screen_width", "renderer.screen_height", "root.position = Vector2.ZERO",
    "root.size = screen", "bg.size = screen", "instance.bounds.width", "instance.bounds.height",
    "minf(screen_width / bounds_width, screen_height / bounds_height) * 0.92",
    "(screen_width - bounds_width * scale) / 2.0", "(screen_height - bounds_height * scale) / 2.0",
    "maxi(256, mini(960, int(floor(bounds_width * scale))))",
    "maxi(192, mini(720, int(floor(bounds_height * scale))))",
    "bottom_mrt.size = Vector2i(texture_width, texture_height)",
    "params_mrt.size = Vector2i(texture_width, texture_height)",
    "float(texture_width) / maxf(1.0, bounds_width)", "float(texture_height) / maxf(1.0, bounds_height)",
    "underwater_rt_root.scale = Vector2(mrt_scale_x, mrt_scale_y)",
    "params_rt_root.scale = Vector2(mrt_scale_x, mrt_scale_y)",
    "bottom_mrt_sprite.texture = bottom_mrt.get_texture()", "bottom_mrt_sprite.position = offset",
    "bottom_mrt_sprite.size = bounds * scale", "underwater_hit_zone.position = offset",
    "underwater_hit_zone.size = bounds * scale", "surface_layer.scale = Vector2.ONE * scale",
    "surface_layer.position = offset", "shore_layer.scale = Vector2.ONE * scale",
    "shore_layer.position = offset", "_layout_shore_banks()", "ui_layer.position = Vector2.ZERO",
    "pull_panel.position = Vector2(screen_width - 120.0, screen_height / 2.0 - 140.0)",
    "feedback.position = Vector2(24.0, screen_height - 72.0)",
    "exit_chrome.position = Vector2(screen_width - exit_chrome.size.x - 12.0, 12.0)",
    "phase == PULL or root.mouse_filter == Control.MOUSE_FILTER_IGNORE",
]), "Godot WaterMinigameScene layout/RT/coordinate/input contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_layout_shore_bank"), [
    "var edge := str(bank.edge)", 'bank.get("overhang")', "maxf(0.0, float(raw_overhang))",
    "else 40.0", 'bank.get("inset")', "is_finite(float(raw_inset))", "else 0.0",
    "maxf(96.0, bounds_width * 0.18)", 'edge == "left" or edge == "right"',
    "maxf(96.0, bounds_height * 0.22)", 'bank.get("thickness")', "float(raw_thickness) > 0.0",
    "else default_thickness", 'edge == "top" or edge == "bottom"',
    "bounds_width + overhang * 2.0", "sprite.position = Vector2(-overhang, inset if edge == \"top\" else bounds_height - inset)",
    '(-1.0 if edge == "top" else 1.0)', "return", "bounds_height + overhang * 2.0",
    'Vector2(inset if edge == "left" else bounds_width - inset, -overhang)',
    '(-1.0 if edge == "left" else 1.0)',
]), "Godot WaterMinigameScene shore layout finite/default/flip contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_cursor_world"), [
    "renderer.screen_width", "renderer.screen_height",
    "minf(screen_width / bounds_width, screen_height / bounds_height) * 0.92",
    "Vector2((screen.x - offset_x) / scale, (screen.y - offset_y) / scale)",
]), "Godot WaterMinigameScene cursorWorld inverse-layout contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_on_underwater_pointer_tap"), [
    "if phase != SEARCH:", "if action_gate.is_locked():", "_cursor_world(event.global_position)",
    "cursor.x < 0.0", "cursor.y < 0.0", "cursor.x > bounds_width", "cursor.y > bounds_height",
    "range(entities.size() - 1, -1, -1)", 'entity.def.category == "floating"',
    "entity.is_escaped()", "not entity.container.visible", "entity.container.position.x",
    "entity.container.position.y + entity.sprite.position.y", "entity.hit_radius()",
    "delta_x * delta_x + delta_y * delta_y <= radius * radius", "_on_entity_tap(entity, event)",
]), "Godot WaterMinigameScene underwater reverse/radius hit routing drift")
require(ordered_tokens(gd_function(gd_water_scene, "_prepare_underwater_pass"), [
    'pass_name == "color"', "bottom_fill.visible = color_pass", "bottom_texture_sprite.visible = color_pass",
    "if entity.params_sprite == null:", "entity.sprite.visible = color_pass",
    "entity.params_sprite.visible = not color_pass",
]), "Godot WaterMinigameScene prepareUnderwaterPass visibility contract drift")

require(ordered_tokens(gd_function(gd_water_scene, "_show_feedback"), [
    "if feedback == null:", "feedback = Label.new()", "font_size\", 15", 'Color("dbeafe")',
    "ui_layer.add_child(feedback)", "feedback.text = _resolve_text_value(message)", "_layout()",
]), "Godot WaterMinigameScene lazy feedback/resolve/layout contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_clear_feedback"), [
    "feedback.free()", "feedback = null",
]), "Godot WaterMinigameScene feedback ownership drift")
require(ordered_tokens(gd_function(gd_water_scene, "_build_exit_ui"), [
    "_clear_exit_ui()", "padding_x := 14.0", "padding_y := 10.0", "gap := 5.0",
    '"[tag:string:waterMinigame:exit]"', '"[tag:string:waterMinigame:exitEscHint]"',
    "maxf(title_size.x, hint_size.x)", "inner_width + padding_x * 2.0",
    "padding_y * 2.0", "StyleBoxFlat.new()", "exit_chrome = Button.new()",
    'pressed.connect(Callable(self, "abort"))', "ui_layer.add_child(exit_chrome)",
]), "Godot WaterMinigameScene exit UI rebuild/geometry/abort contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_on_entity_tap"), [
    "if phase != SEARCH:", "if action_gate.is_locked():", "var definition := entity.def",
    'definition.category == "grass"', 'definition.get("hint", "[tag:string:waterMinigame:grassDefault]")',
    'definition.category == "floating"', "_run_floating_pick(entity)",
    'definition.category == "swimming" or definition.category == "sunken"',
    'definition.get("pull") is Dictionary', "_start_pull(entity)",
    'definition.get("hint", "[tag:string:waterMinigame:nothingToGrab]")',
]), "Godot WaterMinigameScene entity tap branch/action-lock contract drift")
water_pull_ctor = gd_function(gd_water_scene, "_start_pull")
require(ordered_tokens(water_pull_ctor, [
    "phase = PULL", "var pull: Dictionary = entity.def.pull", 'pull.get("timeLimitSec")',
    "float(raw_time_limit) > 0.0", "14.0", 'pull.rhythm == "heavy_sink"',
    "10.0", 'pull.failurePolicy == "snap"', "else 12.0", "_clear_pull()",
    "pull_panel = RuntimeWaterPullPanel.new({", '"zoneSize": float(pull.zoneSize)',
    '"sliderSpeed": float(pull.sliderSpeed)', '"rhythm": str(pull.rhythm)',
    '"failurePolicy": str(pull.failurePolicy)', '"timeLimitSec": time_limit',
    '"resolveText": resolve_text', '"random": random',
    '"onResult": func(result: String) -> void: _on_pull_end(entity, result)',
    "ui_layer.add_child(pull_panel)", "_layout()",
]), "Godot WaterMinigameScene pull time-limit/params-owned-random/callback contract drift")
require(ordered_tokens(gd_function(gd_water_scene, "_on_pull_end"), [
    "_clear_pull()", "phase = SEARCH", 'result == "abort"', 'on_finish.call("abort")',
    'result == "success"', "await _run_actions(entity.def.get(\"onPullSuccess\"))",
    'entity.def.get("consumeOnSuccess") == true', "_set_entity_visible(entity, false)",
    "on_consumed.call(str(instance.id), str(entity.def.id))", "_fill_token(",
    '"[tag:string:waterMinigame:pullSuccessPrefix]"', '"{cue}"', "return",
    'await _run_actions(entity.def.get("onPullFail"))', 'result == "fail_escape"',
    '"[tag:string:waterMinigame:pullEscape]"', "_set_entity_visible(entity, false)",
    'result == "fail_snap"', '"[tag:string:waterMinigame:pullSnap]"',
    '"[tag:string:waterMinigame:pullBite]"',
]), "Godot WaterMinigameScene pull result/action/consume/feedback order drift")
water_scene_update = gd_function(gd_water_scene, "update")
require(ordered_tokens(water_scene_update, [
    "time += dt", "_water_filter_set_time(time)", "var ambient := _ambient()",
    "var cursor := _cursor_world(mouse_screen)", "entity.update(dt, ambient, cursor)",
    'grass.def.category != "grass"', "var magnitude := 0.0", 'swimmer.def.category != "swimming"',
    "delta_x * delta_x + delta_y * delta_y < 55.0 * 55.0", "magnitude += 1.0",
    "if magnitude > 0.0:", "grass.react_grass(magnitude, 0.0, 0.0)",
    "phase == PULL and pull_panel != null", "pull_panel.set_lift_held(bool(get_key_hold.call()))",
    "pull_panel.update(dt)", '_prepare_underwater_pass("color")',
    '_prepare_underwater_pass("params")', '_prepare_underwater_pass("color")',
    "_restore_separate_pass_visibility()",
]), "Godot WaterMinigameScene raw-dt/entity/grass/pull/two-pass update drift")
require(ordered_tokens(gd_function(gd_water_scene, "destroy"), [
    "unsub_resize.call()", "unsub_resize = null", "_clear_pull()", "_clear_feedback()",
    "_clear_exit_ui()", "for sprite: Sprite2D in shore_sprites:", "sprite.free()",
    "shore_sprites = []", "for entity: RuntimeWaterEntity in entities:", "entity.destroy()",
    "entities = []", "bottom_mrt_sprite.material = null", "water_filter = null", "root.free()",
]), "Godot WaterMinigameScene destroy ownership/lifecycle drift")

require(ordered_tokens(gd_function(gd_water_scene, "_on_pointer_input"), [
    "event is InputEventMouseButton", "event.button_index != MOUSE_BUTTON_LEFT", "not event.pressed",
    "_cursor_world(event.global_position)", "range(entities.size() - 1, -1, -1)",
    'entity.def.category != "floating"', "entity.is_escaped()", "not entity.container.visible",
    "_floating_sprite_contains(entity, cursor)", "entity._emit_pointer_tap(event)", "return",
    "_on_underwater_pointer_tap(event)",
]), "Godot WaterMinigameScene surface-first engine hit adapter drift")
require(ordered_tokens(gd_function(gd_water_scene, "_floating_sprite_contains"), [
    "entity.sprite.texture", "if texture == null:", "texture.get_width()", "texture.get_height()",
    "entity.sprite.scale.abs()", "entity.container.position + entity.sprite.position",
    "Rect2(center - size * 0.5, size).has_point(point)",
]), "Godot WaterMinigameScene floating Sprite-bounds hit adapter drift")
require(ordered_tokens(gd_function(gd_water_scene, "_run_floating_pick"), [
    'await _run_actions(entity.def.get("onPick"))', 'entity.def.get("consumeOnSuccess") == true',
    "_set_entity_visible(entity, false)", "on_consumed.call(str(instance.id), str(entity.def.id))",
    '"[tag:string:waterMinigame:pickPrefix]"', '"{cue}"', 'entity.def.get("cue", entity.def.id)',
]), "Godot WaterMinigameScene floating async action/consume/first-token feedback drift")
require(ordered_tokens(gd_function(gd_water_scene, "_set_entity_visible"), [
    "entity.container.visible = visible", "entity.params_container != null",
    "entity.params_container.visible = visible",
]), "Godot WaterMinigameScene separate-SubViewport visibility adapter drift")
require(ordered_tokens(gd_function(gd_water_scene, "_draw_bottom_fill"), [
    "layer.draw_rect(", "_color_from_int(bottom_tint)", "var y := 0.0", "while y < height:",
    "y / maxf(1.0, height)", "Rect2(0.0, y, width, 24.0)", "0.06 + ratio * 0.16",
    "y += 48.0", "var x := 0.0", "while x < width:",
    "Vector2(x, 0.0)", "Vector2(x + 34.0, height)", 'Color("2f5266", 0.16)', "x += 64.0",
]), "Godot WaterMinigameScene bottom bands/diagonal-lines draw adapter drift")
require(ordered_tokens(gd_function(gd_water_scene, "_fill_token"), [
    "text.find(token)", "if index < 0:", "return text",
    "text.substr(0, index) + value + text.substr(index + token.length())",
]), "Godot WaterMinigameScene fillToken first-only adapter drift")

require(ordered_tokens(ts_minigame_script, [
    "function pickFromPool", "const arr = ctx.vars[poolName]", "Math.floor(ctx.rng() * arr.length)",
    "function field(", "export function coreOpcodes", "pick(step, ctx)", "wait(step)",
    "chance(step, ctx, runChildren)", "export function createMinigameScriptRunner", "let gen", "let waitRemain",
    "function* execute", "const handler = registry[step.op]", "unknown op", "const runChildren",
    "const result = handler", "yield* execute(result.__children)", "yield result", "runPhase(steps",
    "gen = execute(steps)", "waitRemain = 0", "const r = gen.next()", "tick(dt", "waitRemain -= dt",
    "while (gen && waitRemain <= 0)", "waitRemain += r.value", "cancel()", "get running()",
]), "TypeScript minigameScript module/core/generator architecture drift")
minigame_script_fields = re.findall(r"^var ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_script, flags=re.MULTILINE)
minigame_script_methods = re.findall(r"^(?:static )?func ([A-Za-z_][A-Za-z0-9_]*)", gd_minigame_script, flags=re.MULTILINE)
require(minigame_script_fields == ["registry", "context", "stack", "wait_remain"],
        f"Godot minigameScript runner field architecture/order drift: {minigame_script_fields}")
require(minigame_script_methods == [
    "_pick_from_pool", "_field", "core_opcodes", "_init", "run_phase", "tick", "cancel", "is_running",
    "_pump", "_child_block", "_js_string", "_js_number", "_parse_radix",
], f"Godot minigameScript module/runner method architecture/order drift: {minigame_script_methods}")
require(ordered_tokens(gd_function(gd_minigame_script, "core_opcodes"), [
    '"pick": func', 'var pool :=', 'var slot :=', "ctx.slots[slot] = _pick_from_pool",
    '"wait": func', 'var raw: Variant = _field(step, "sec")', "return maxf(0.0, seconds)",
    '"chance": func', 'var raw: Variant = _field(step, "p")', "float(rng.call()) < probability",
    'var then_steps: Variant = _field(step, "then")', "return run_children.call(then_steps)",
    'var else_steps: Variant = _field(step, "else")', "return run_children.call(else_steps)",
]), "Godot minigameScript core opcode/nullish/branch order drift")
require(ordered_tokens(gd_function(gd_minigame_script, "_init"), [
    "registry = next_registry", "context = next_context",
]) and "duplicate" not in gd_function(gd_minigame_script, "_init"),
        "Godot minigameScript factory no longer retains live registry/context identity")
require(ordered_tokens(gd_function(gd_minigame_script, "run_phase"), [
    "stack.clear()", "wait_remain = 0.0", 'stack.push_back({"steps": steps, "index": 0})', "_pump()",
]) and "duplicate" not in gd_function(gd_minigame_script, "run_phase"),
        "Godot minigameScript runPhase root generator/reference semantics drift")
require(ordered_tokens(gd_function(gd_minigame_script, "tick"), [
    "if stack.is_empty()", "wait_remain -= dt", "while not stack.is_empty() and wait_remain <= 0.0", "_pump()",
]), "Godot minigameScript tick/overshoot generator semantics drift")
minigame_pump = gd_function(gd_minigame_script, "_pump")
require(ordered_tokens(minigame_pump, [
    "registry.get(step.op)", 'push_warning("[minigameScript] unknown op: %s"',
    'handler.call(step, context, Callable(self, "_child_block"))', 'result.has("__children")',
    'stack.push_back({"steps": result.__children', "float(result) > 0.0", "wait_remain += float(result)",
]) and "unknown_ops" not in gd_minigame_script and "_run_core_opcode" not in gd_minigame_script,
        "Godot minigameScript registry/unknown/child/wait execution drift")
require('steps.duplicate(false)' in gd_function(gd_minigame_script, "_child_block") and "duplicate(true)" not in gd_minigame_script,
        "Godot minigameScript runChildren must shallow-copy only the child array")
require(ordered_tokens(gd_function(gd_sugar_wheel_atmosphere, "select_group"), [
    "RuntimeMinigameScriptRunner.core_opcodes()", "registry.merge(_sugar_wheel_opcodes(host), true)",
    "RuntimeMinigameScriptRunner.new(registry, ctx)",
]), "Godot SugarWheel atmosphere does not spread core opcodes before host overrides")

collect = section(bootstrap, "func collect_save_data()", "func distribute_save_data")
require(all(token in collect for token in ['for entry: Dictionary in registered_systems:', 'entry.system.serialize()', '["flagStore"]', '["dialogueLog"]', '["game"]']), "Godot save collector is missing a TypeScript-owned save partition")
distribute = section(bootstrap, "func distribute_save_data", "func reload_saved_scene")
require(all(token in distribute for token in ['emit("save:restoring"', "set_restoring(true)", "flag_store.deserialize", 'for entry: Dictionary in registered_systems:', "entry.system.deserialize", "dialogue_log_ui.deserialize", "randomState", "set_restoring(false)"]), "Godot save distributor lifecycle drift")

if errors:
    print("Architecture parity audit: FAIL")
    for index, error in enumerate(errors, 1):
        print(f"  {index}. {error}")
    raise SystemExit(1)

print("Architecture parity audit: PASS")
