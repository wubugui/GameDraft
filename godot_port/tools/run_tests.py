#!/usr/bin/env python3
"""Run Godot-port contracts and reject false-zero errors, warnings, and exit leaks."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
DEFAULT_GODOT = Path("/Applications/Godot.app/Contents/MacOS/Godot")

SCRIPT_TESTS = [
    ("res://tests/runtime_root_test.gd", "RuntimeRoot lifecycle test: PASS"),
    ("res://tests/event_bus_test.gd", "RuntimeEventBus semantics test: PASS"),
    ("res://tests/input_manager_test.gd", "InputManager parity test: PASS"),
    ("res://tests/game_state_controller_test.gd", "GameStateController parity test: PASS"),
    ("res://tests/resource_locator_test.gd", "ResourceLocator contract test: PASS"),
    ("res://tests/asset_manager_test.gd", "AssetManager contract test: PASS"),
    ("res://tests/strings_provider_test.gd", "StringsProvider contract test: PASS"),
    ("res://tests/text_resolver_test.gd", "TextResolver/Rich tag contract test: PASS"),
    ("res://tests/flag_store_test.gd", "FlagStore registry/comparison test: PASS"),
    ("res://tests/condition_evaluator_test.gd", "ConditionEvaluator 9-node contract test: PASS"),
    ("res://tests/inventory_manager_test.gd", "InventoryManager contract test: PASS"),
    ("res://tests/rules_manager_test.gd", "RulesManager contract test: PASS"),
    ("res://tests/scenario_state_manager_test.gd", "ScenarioStateManager contract test: PASS"),
    ("res://tests/narrative_graph_compiler_test.gd", "Narrative graph compiler contract test: PASS"),
    ("res://tests/smell_system_test.gd", "SmellSystem contract test: PASS"),
    ("res://tests/rule_offer_registry_test.gd", "RuleOfferRegistry contract test: PASS"),
    ("res://tests/camera_test.gd", "Camera projection/follow/bounds test: PASS"),
    ("res://tests/light_env_curve_test.gd", "LightEnvCurve projection/interpolation/copy parity test: PASS"),
    ("res://tests/pixel_density_match_test.gd", "Entity pixel-density K/blur/frame parity test: PASS"),
]

SCENE_TESTS = [
    ("res://tests/action_executor_test.tscn", "ActionExecutor queue/policy test: PASS"),
    ("res://tests/action_composition_test.tscn", "Action composition/choice/random contract test: PASS"),
    ("res://tests/action_scenario_narrative_test.tscn", "Scenario/narrative Action contract test: PASS"),
    ("res://tests/action_inventory_rules_test.tscn", "Inventory/rules/quest/shop Action contract test: PASS"),
    ("res://tests/action_wellbeing_test.tscn", "Day/archive/health/smell/document Action contract test: PASS"),
    ("res://tests/action_plane_test.tscn", "Plane Action contract test: PASS"),
    ("res://tests/action_entity_test.tscn", "Entity/patrol/override Action contract test: PASS"),
    ("res://tests/action_scene_camera_test.tscn", "Scene switch/camera Action contract test: PASS"),
    ("res://tests/action_performance_test.tscn", "Audio/emote/fade/blend/wait-click/avatar Action contract test: PASS"),
    ("res://tests/pressure_hold_manager_test.tscn", "PressureHoldManager 8-def/interrupt/reset/release/action contract test: PASS"),
    ("res://tests/pressure_hold_ui_test.tscn", "PressureHoldUI hold/release/cancel/cleanup contract test: PASS"),
    ("res://tests/pressure_hold_integration_test.tscn", "PressureHold Action/UIOverlay/JSON/state integration test: PASS"),
    ("res://tests/minigame_session_test.tscn", "MinigameSession duplicate/Esc/scope/state/destroy/action-gate contract test: PASS"),
    ("res://tests/paper_craft_integration_test.tscn", "PaperCraft real instance/drag-click/score/action/session integration test: PASS"),
    ("res://tests/minigame_script_runner_test.tscn", "MinigameScript pick/wait/chance/children/unknown/cancel contract test: PASS"),
    ("res://tests/sugar_wheel_spin_physics_test.tscn", "SugarWheel physics/layout/weight/golden landing parity test: PASS"),
    ("res://tests/sugar_wheel_atmosphere_test.tscn", "SugarWheel atmosphere phase/pending/near-sector script contract test: PASS"),
    ("res://tests/sugar_wheel_integration_test.tscn", "SugarWheel 2-instance/drag/charge/condition/physics/actions/speech/session integration test: PASS"),
    ("res://tests/water_entity_test.tscn", "WaterEntity size/hit/depth/motion/glow/flee/param-pass contract test: PASS"),
    ("res://tests/water_pull_panel_test.tscn", "WaterPullPanel stable-success/rhythm/three-failures/abort contract test: PASS"),
    ("res://tests/water_integration_test.tscn", "Water five-instance/render/pick/pull/failure/degrade/save/action integration test: PASS"),
    ("res://tests/scene_depth_system_test.tscn", "SceneDepth load/shader/collision/floor-zone/actions/unload contract test: PASS"),
    ("res://tests/advanced_rendering_test.tscn", "Advanced rendering filter/pipeline/lighting/planar/deferred/shadow-field integration test: PASS"),
    ("res://tests/shop_ui_test.tscn", "ShopUI 2-def/open/purchase/insufficient/rebuild/close/state Action integration test: PASS"),
    ("res://tests/runtime_panels_test.tscn", "Notification/Pickup/Inventory/Quest/Rules UI data/input/action lifecycle test: PASS"),
    ("res://tests/secondary_panels_test.tscn", "ActionChoice/DialogueLog/RuleUse UI input/data/action lifecycle test: PASS"),
    ("res://tests/archive_ui_test.tscn", "Bookshelf/Character/Lore/Document/BookReader archive JSON/read/navigation lifecycle test: PASS"),
    ("res://tests/hud_map_menu_test.tscn", "HUD/Smell/Map/Menu shared-data/events/travel/settings lifecycle test: PASS"),
    ("res://tests/dev_touch_ui_test.tscn", "DebugPanel/DevMode/TouchMobileControls shared-state/input lifecycle test: PASS"),
    ("res://tests/inspect_box_test.tscn", "InspectBox show/re-show/input-close contract test: PASS"),
    ("res://tests/dialogue_ui_test.tscn", "DialogueUI typewriter/advance/choice lifecycle test: PASS"),
    ("res://tests/dialogue_manager_test.tscn", "DialogueManager scripted/nested/end contract test: PASS"),
    ("res://tests/encounter_manager_test.tscn", "EncounterManager two-def/options/consume/result contract test: PASS"),
    ("res://tests/audio_manager_test.tscn", "AudioManager config/mix/scene/capture/system-SFX lifecycle test: PASS"),
    ("res://tests/emote_bubble_manager_test.tscn", "EmoteBubble follow/hotspot/sticky/owner/wait lifecycle test: PASS"),
    ("res://tests/encounter_ui_test.tscn", "EncounterUI four-phase/input/choice-lock lifecycle test: PASS"),
    ("res://tests/cutscene_present_test.tscn", "CutsceneRenderer 16-present primitive contract test: PASS"),
    ("res://tests/cutscene_manager_test.tscn", "CutsceneManager session/parallel/policy/skip contract test: PASS"),
    ("res://tests/cutscene_integration_test.tscn", "Real teahouse cutscene Action/audio/present/state integration test: PASS"),
    ("res://tests/bootstrap_on_enter_cutscene_test.tscn", "Bootstrap real scene onEnter-to-cutscene chain test: PASS"),
    ("res://tests/player_path_e2e_test.tscn", "No-debug new-game/dialogue/production-transition player path E2E: PASS"),
    ("res://tests/mainline_opening_arc_e2e_test.tscn", "No-debug 22-scene full mainline/side-path new-game-to-s12_chufa E2E: PASS"),
    ("res://tests/all_cutscenes_smoke_test.tscn", "All 20 cutscene definitions executable/cleanup closure test: PASS"),
    ("res://tests/save_manager_test.tscn", "SaveManager atomic/interoperable test: PASS"),
    ("res://tests/quest_manager_test.tscn", "QuestManager contract test: PASS"),
    ("res://tests/narrative_signal_queue_test.tscn", "Narrative signal queue contract test: PASS"),
    ("res://tests/narrative_reactive_test.tscn", "Narrative reactive contract test: PASS"),
    ("res://tests/narrative_owner_save_test.tscn", "Narrative owner/reached/save contract test: PASS"),
    ("res://tests/plane_reconciler_test.tscn", "PlaneReconciler contract test: PASS"),
    ("res://tests/plane_runtime_integration_test.tscn", "Plane runtime entity/zone/camera/movement/lighting binding integration test: PASS"),
    ("res://tests/live_condition_provider_test.tscn", "Live 9-node condition provider test: PASS"),
    ("res://tests/day_manager_test.tscn", "DayManager contract test: PASS"),
    ("res://tests/health_system_test.tscn", "HealthSystem contract test: PASS"),
    ("res://tests/archive_manager_test.tscn", "ArchiveManager contract test: PASS"),
    ("res://tests/document_reveal_manager_test.tscn", "DocumentRevealManager contract test: PASS"),
    ("res://tests/renderer_test.tscn", "Renderer layer/resize lifecycle test: PASS"),
    ("res://tests/sprite_entity_test.tscn", "SpriteEntity 36-manifest atlas contract test: PASS"),
    ("res://tests/player_test.tscn", "Player movement/cutscene/modifier contract test: PASS"),
    ("res://tests/npc_test.tscn", "Npc registry/visibility/movement/patrol contract test: PASS"),
    ("res://tests/hotspot_test.tscn", "Hotspot five-type/display/visibility/collision contract test: PASS"),
    ("res://tests/scene_manager_test.tscn", "SceneManager 27-scene JSON/asset/instantiate contract test: PASS"),
    ("res://tests/scene_memory_test.tscn", "SceneManager spawn/transition/memory/override contract test: PASS"),
    ("res://tests/scene_on_enter_test.tscn", "Scene ready/reveal/onEnter/reentrant-switch contract test: PASS"),
    ("res://tests/interaction_system_test.tscn", "InteractionSystem distance/condition/plane/auto-trigger contract test: PASS"),
    ("res://tests/interaction_coordinator_test.tscn", "InteractionCoordinator inspect/pickup/transition/npc/encounter routing test: PASS"),
    ("res://tests/zone_system_test.tscn", "ZoneSystem polygon/enter-stay-exit/restore contract test: PASS"),
    ("res://tests/graph_dialogue_manager_test.tscn", "GraphDialogueManager seven-node/63-graph contract test: PASS"),
    ("res://tests/dialogue_integration_test.tscn", "NPC real-JSON dialogue/UI/state/camera integration test: PASS"),
    ("res://tests/scripted_dialogue_integration_test.tscn", "playScriptedDialogue Action/UI/context integration test: PASS"),
    ("res://tests/encounter_integration_test.tscn", "Hotspot real encounter/UI/reward/state integration test: PASS"),
    ("res://tests/core_lifecycle_stress_test.tscn", "Core lifecycle stress test: PASS"),
]


def run(command: list[str], marker: str, *, allow_intentional_listener_error: bool = False) -> None:
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=150,
        check=False,
    )
    output = result.stdout + result.stderr
    bad_error = "SCRIPT ERROR:" in output or "ERROR:" in output
    if allow_intentional_listener_error:
        bad_error = bad_error and "intentional listener failure probe" not in output
    leak_markers = (
        "ObjectDB instances leaked at exit",
        "Resources still in use at exit",
        "RID allocations leaked at exit",
        "Orphan StringName",
    )
    bad_warning = "WARNING:" in output
    bad_leak = any(value in output for value in leak_markers)
    if result.returncode != 0 or marker not in output or bad_error or bad_warning or bad_leak:
        raise RuntimeError(
            f"test failed: {' '.join(command)}\nexit={result.returncode}\n{output[-12000:]}"
        )
    print(marker)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--godot", default=str(DEFAULT_GODOT))
    parser.add_argument("--full-parity", action="store_true", help="also launch and compare both live shells")
    args = parser.parse_args()
    godot = args.godot

    run([sys.executable, str(PORT_ROOT / "tools/audit_temporary_bypasses.py")], "Temporary bypass audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_dialogue_graphs.py")], "Dialogue graph route audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_scene_routes.py")], "Scene route topology audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_content_warnings.py")], "Content warning fallback classification: PASS")
    run([godot, "--headless", "--path", str(PORT_ROOT), "--import"], "[ DONE ]")
    for path, marker in SCRIPT_TESTS:
        run([godot, "--headless", "--path", str(PORT_ROOT), "--script", path], marker)
    run(
        [godot, "--headless", "--path", str(PORT_ROOT), "--script", "res://tests/event_bus_error_probe.gd"],
        "EventBus listener isolation probe: PASS",
        allow_intentional_listener_error=True,
    )
    for path, marker in SCENE_TESTS:
        run([godot, "--headless", "--path", str(PORT_ROOT), "--scene", path], marker)
    run(
        [sys.executable, str(PORT_ROOT / "tools/parity_runner.py"), "godot", "--godot", godot],
        "Godot ping/captureSnapshot: PASS",
    )
    run(
        [sys.executable, str(PORT_ROOT / "tools/save_interop_e2e.py"), "--godot", godot],
        "TypeScript→Godot→TypeScript→Godot bidirectional save E2E: PASS",
    )
    if args.full_parity:
        run(
            [sys.executable, str(PORT_ROOT / "tools/parity_runner.py"), "run", "--godot", godot, "--require-equal"],
            "field differences:",
        )
    print("Godot port test suite: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
