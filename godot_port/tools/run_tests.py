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
    ("res://tests/deterministic_random_test.gd", "DeterministicRandom UTF-8 seed/factory-closure/xorshift/state direct-translation test: PASS"),
	("res://tests/animation_set_resolver_test.gd", "AnimationSet normalization direct-translation test: PASS"),
	("res://tests/placeholder_factory_test.gd", "PlaceholderFactory background/player atlas direct-translation test: PASS"),
    ("res://tests/scripted_dialogue_speaker_test.gd", "ScriptedDialogueSpeaker display/entity direct-translation test: PASS"),
    ("res://tests/text_resolver_test.gd", "TextResolver/Rich tag contract test: PASS"),
    ("res://tests/flag_store_test.gd", "FlagStore registry/comparison test: PASS"),
	("res://tests/condition_evaluator_test.gd", "ConditionEvaluator module-function/order/short-circuit/trace direct-translation test: PASS"),
    ("res://tests/inventory_manager_test.gd", "InventoryManager field/load/number/events/save direct-translation test: PASS"),
    ("res://tests/rules_manager_test.gd", "RulesManager normalize/field/load/layer/save direct-translation test: PASS"),
    ("res://tests/scenario_state_manager_test.gd", "ScenarioStateManager contract test: PASS"),
    ("res://tests/narrative_graph_compiler_test.gd", "Narrative graph compiler contract test: PASS"),
	("res://tests/narrative_graph_validation_test.gd", "Narrative graph validation direct-translation test: PASS"),
    ("res://tests/hold_progress_test.gd", "HoldProgress fill/decay/stop/validation direct-translation test: PASS"),
    ("res://tests/dev_error_overlay_test.gd", "DevErrorOverlay/depthLog direct-translation test: PASS"),
    ("res://tests/smell_system_test.gd", "SmellSystem contract test: PASS"),
    ("res://tests/rule_offer_registry_test.gd", "RuleOfferRegistry contract test: PASS"),
    ("res://tests/camera_test.gd", "Camera projection/follow/bounds test: PASS"),
    ("res://tests/light_env_curve_test.gd", "LightEnvCurve projection/interpolation/copy parity test: PASS"),
	("res://tests/light_env_resolver_test.gd", "LightEnv baseline/merge/clamp/precedence/length direct-translation test: PASS"),
	("res://tests/shadow_field_test.gd", "UniformShadowField reference/direction/length direct-translation test: PASS"),
	("res://tests/background_debug_filter_test.gd", "BackgroundDebugFilter uniforms/depth-range/collision-projection engine translation test: PASS"),
	("res://tests/entity_shading_filters_test.gd", "DepthOcclusion/EntityLighting direct-class/uniform/shader test: PASS"),
	("res://tests/world_filter_pipeline_test.gd", "WorldFilterPipeline ordered-pass/reference direct-translation test: PASS"),
    ("res://tests/pixel_density_match_test.gd", "Entity pixel-density K/blur/filter direct-translation test: PASS"),
]

EXPECTED_WARNINGS = {
	"res://tests/condition_evaluator_test.gd": {
		"evaluateConditionExprList: conditions must be an array": 1,
		"evaluateConditionExpr: depth exceeded": 1,
		"evaluateConditionExprWithTrace: depth exceeded": 1,
		"evaluateConditionExpr: unrecognized shape": 2,
	},
    "res://tests/flag_store_test.gd": {
        "FlagStore.set: 忽略空 flag 键": 1,
        "[addFlagValue] key": 1,
        "[appendFlag] key": 1,
        "未知运算符": 1,
        "缺少 ConditionEvalContext": 1,
        "存档含空 flag 键": 1,
        "unknown flag key in save": 1,
    },
    "res://tests/action_executor_test.tscn": {
        "debugAlertActionParams (no alert)": 1,
        "命中执行策略": 1,
        "unknown action type": 1,
        "实例已销毁": 1,
    },
    "res://tests/action_scenario_narrative_test.tscn": {
        "emitNarrativeSignal: missing signal": 1,
    },
    "res://tests/action_inventory_rules_test.tscn": {
        "giveCurrency: 金额为负": 1,
    },
    "res://tests/action_wellbeing_test.tscn": {
        "addDelayedEvent: 已跳过无效的嵌套动作项": 1,
    },
    "res://tests/action_plane_test.tscn": {
        "PlaneReconciler: activatePlane 未注册的位面 \"missing\"": 1,
    },
    "res://tests/action_scene_camera_test.tscn": {
        "setCameraZoom: params.zoom 需为有限正数": 1,
    },
	"res://tests/game_avatar_translation_test.tscn": {
		"applyPlayerAvatar: 无法加载 /missing/anim.json": 1,
		"playerAvatar.stateMap": 1,
	},
	"res://tests/game_hotspot_display_image_translation_test.tscn": {
		"setEntityField: hotspot displayImage 加载失败": 1,
		"setHotspotDisplayImage: 贴图加载失败": 1,
	},
	"res://tests/all_cutscenes_smoke_test.tscn": {
		"setHotspotDisplayImage: 过场中忽略跨场景写入": 1,
	},
    "res://tests/scene_memory_test.tscn": {
        "SceneManager: 过场中忽略跨场景 sceneMemory 写入": 2,
        "mergePersistentZoneEnabled: 无法写入 sceneMemory": 1,
    },
    "res://tests/paper_craft_integration_test.tscn": {
        "debugAlertActionParams (no alert)": 1,
    },
}

EXPECTED_ERRORS = {
	"res://tests/condition_evaluator_test.gd": {
		'条件引用不存在的叙事图 "dangling"': 1,
	},
	"res://tests/action_executor_test.tscn": {
        "ActionExecutor: 数据引用了未注册的动作类型": 1,
    },
    "res://tests/graph_dialogue_manager_test.tscn": {
        "[json] 加载失败:": 1,
    },
	"res://tests/narrative_owner_save_test.tscn": {
		"[narrative] 叙事信号": 1,
	},
	"res://tests/player_path_e2e_test.tscn": {
		"[narrative] 叙事信号 \"state:flow_xungou_main:s01_tingshu\"": 1,
	},
	"res://tests/mainline_opening_arc_e2e_test.tscn": {
		"[narrative] 叙事信号": 13,
	},
}

EXPECTED_WARNINGS["res://tests/narrative_signal_queue_test.tscn"] = {
	"uses unsupported cross-graph endpoint data": 2,
	"refusing to emit draft signal": 1,
	"invalid signal (missing event id)": 1,
	"debugSetNarrativeState bypasses transitions": 2,
	"setState target violates scenario boundary": 1,
}
EXPECTED_WARNINGS["res://tests/narrative_reactive_test.tscn"] = {
	"drain loop guard tripped": 2,
}
EXPECTED_WARNINGS["res://tests/narrative_state_manager_direct_test.tscn"] = {
	"debugSetNarrativeState bypasses transitions": 1,
	"lifecycle actions failed": 1,
}
EXPECTED_WARNINGS["res://tests/narrative_owner_save_test.tscn"] = {
	"duplicate graph id": 1,
	"skipped invalid graph": 1,
	"owner has multiple wrapper graphs": 1,
	"primary owner lookup is ambiguous": 1,
	"debugSetNarrativeState bypasses transitions": 2,
	"save references unknown narrative graph": 3,
	"save references unknown state": 2,
}
EXPECTED_WARNINGS["res://tests/document_reveal_manager_test.tscn"] = {
	"debugSetNarrativeState bypasses transitions": 1,
	"DocumentRevealManager: 无法加载 document_reveals.json": 1,
	"DocumentRevealManager: 未知 documentId": 1,
	"DocumentRevealManager: blend 未注入": 1,
	"DocumentRevealManager: reveal retry failed": 1,
}
EXPECTED_WARNINGS["res://tests/live_condition_provider_test.tscn"] = {
	"evaluateConditionExpr: unrecognized shape": 1,
}
EXPECTED_WARNINGS["res://tests/cutscene_manager_test.tscn"] = {
	"CutsceneManager: Action type \"setFlag\" modifies global save state": 1,
}
EXPECTED_WARNINGS["res://tests/signal_cue_manager_test.tscn"] = {
	"SignalCueManager: 非法 cue 配置，已跳过": 3,
	"SignalCueManager: signal_cues.json not found": 1,
	"SignalCueManager: unknown signal cue": 1,
	"SignalCueManager: cue \"loop\" 重入被忽略": 1,
}
EXPECTED_WARNINGS["res://tests/health_system_test.tscn"] = {
	"HealthSystem: death-tether actions failed": 1,
}
EXPECTED_WARNINGS["res://tests/minigame_session_test.tscn"] = {
	"已有小游戏会话进行中，忽略重复启动": 1,
	"unknown instance \"unknown\"": 1,
	"scene load failed": 1,
	"runtime not bound": 1,
}
EXPECTED_WARNINGS["res://tests/minigame_script_runner_test.tscn"] = {
	"[minigameScript] unknown op: unknown_probe": 2,
}
EXPECTED_WARNINGS["res://tests/audio_manager_test.tscn"] = {
	"AudioManager: unknown transient sfx \"missing\"": 1,
}
EXPECTED_WARNINGS["res://tests/pressure_hold_manager_test.tscn"] = {
	"PressureHoldManager: 配置 \"": 3,
	"PressureHoldManager: pressure_holds.json not found": 1,
	"PressureHoldManager: unknown pressure hold \"unknown\"": 1,
	"PressureHoldManager: runtime 未绑定（bindRuntime）": 1,
	"PressureHoldManager: 已有长按交互进行中，忽略 \"reset_probe\"": 1,
}
EXPECTED_WARNINGS["res://tests/inventory_manager_test.gd"] = {
	"InventoryManager: items.json not found, running without item definitions": 2,
	"InventoryManager.addCoins: 非法金额": 1,
	"InventoryManager.removeCoins: 非法金额": 1,
}
EXPECTED_WARNINGS["res://tests/rules_manager_test.gd"] = {
	"RulesManager: rules.json not found, running without rule definitions": 1,
	"RulesManager: unknown fragment \"unknown\"": 1,
}
EXPECTED_WARNINGS["res://tests/quest_manager_test.tscn"] = {
	"QuestManager: quests.json not found, running without quest definitions": 1,
	"QuestManager: acceptActions failed": 1,
	"QuestManager: rewards failed": 1,
	"QuestManager: queued quest actions failed": 1,
}
EXPECTED_WARNINGS["res://tests/encounter_manager_test.tscn"] = {
	"EncounterManager: encounters.json not found": 1,
	"EncounterManager: unknown encounter \"missing\"": 1,
	"EncounterManager: resultActions failed": 1,
}
EXPECTED_ERRORS["res://tests/encounter_manager_test.tscn"] = {
	"EncounterManager: encounter \"synthetic_empty\" 过滤后选项集为空": 1,
}
EXPECTED_WARNINGS["res://tests/plane_reconciler_test.tscn"] = {
	"PlaneReconciler: loadDefs 前未 init": 1,
	"PlaneReconciler: planes.json not found": 1,
	"PlaneReconciler: 位面配置 \"bad\" 非法": 1,
	"extends 链存在环": 2,
	"extends 的父位面 \"missing\" 不存在": 1,
	"PlaneReconciler: activatePlane 需要非空 id": 1,
	"PlaneReconciler: activatePlane 未注册的位面 \"missing\"": 1,
	"PlaneReconciler: 掉阳气 damage 失败": 1,
	"PlaneReconciler: 激活位面 \"ghost\" 未在 planes.json 注册": 1,
}
EXPECTED_ERRORS["res://tests/plane_reconciler_test.tscn"] = {
	"PlaneReconciler: 多个叙事图同时点名了不同位面": 1,
}
EXPECTED_WARNINGS["res://tests/graph_dialogue_manager_test.tscn"] = {
	"GraphDialogueManager: 图 request_owner_must_not_leak preconditions 不满足": 1,
	"GraphDialogueManager: 图 invalid_shape 缺少 entry 或 nodes": 1,
	"与路径 graphId": 2,
	"GraphDialogueManager: 已有对话进行中，忽略重复 start": 1,
	"GraphDialogueManager: ownerState owner is ambiguous": 1,
	"GraphDialogueManager: runActions 执行失败，结束对话": 1,
	"GraphDialogueManager: line 节点无可用台词 empty": 1,
	"GraphDialogueManager: contextState n_1 cannot read active state": 2,
	"GraphDialogueManager: 无法加载 /assets/dialogues/graphs/definitely_missing.json": 1,
}
EXPECTED_ERRORS["res://tests/graph_dialogue_manager_test.tscn"] = {
	"[json] 加载失败:": 1,
	"[dialogue] 对话图 \"invalid_shape\" 缺少 entry 或 nodes": 1,
	"GraphDialogueManager: choice 节点 locked": 1,
	"GraphDialogueManager: 图 routing_loop 单次推进超过": 1,
}

SCENE_TESTS = [
	("res://tests/runtime_command_parity_test.tscn", "Runtime command 35-type/nav/tick/snapshot architecture parity test: PASS"),
	("res://tests/click_continue_prompt_test.tscn", "ClickContinuePrompt layout/debounce/cleanup direct-translation test: PASS"),
	("res://tests/hud_smell_lifecycle_test.tscn", "HUD deferred smell profiles/state replay direct-translation test: PASS"),
    ("res://tests/action_executor_test.tscn", "ActionExecutor queue/policy test: PASS"),
    ("res://tests/action_composition_test.tscn", "Action composition/choice/random contract test: PASS"),
    ("res://tests/action_scenario_narrative_test.tscn", "Scenario/narrative Action contract test: PASS"),
    ("res://tests/action_inventory_rules_test.tscn", "Inventory/rules/quest/shop Action contract test: PASS"),
    ("res://tests/action_wellbeing_test.tscn", "Day/archive/health/smell/document Action contract test: PASS"),
    ("res://tests/action_plane_test.tscn", "Plane Action contract test: PASS"),
    ("res://tests/action_entity_test.tscn", "Entity/patrol/override Action contract test: PASS"),
	("res://tests/game_patrol_restart_test.tscn", "Game patrolDisabled false stop-before-restart direct-translation test: PASS"),
	("res://tests/game_hotspot_display_image_translation_test.tscn", "Game hotspot display-image transaction/filter-ownership direct-translation test: PASS"),
	("res://tests/game_scene_lifecycle_translation_test.tscn", "Game scene enter/ready/reveal/density/unload direct-translation test: PASS"),
	("res://tests/game_entities_rebuilt_shadow_identity_test.tscn", "Game entitiesRebuilt targeted shadow/filter identity direct-translation test: PASS"),
	("res://tests/game_startup_options_translation_test.tscn", "Game start options/dev route/ready-guard direct-translation test: PASS"),
    ("res://tests/action_scene_camera_test.tscn", "Scene switch/camera Action contract test: PASS"),
    ("res://tests/action_performance_test.tscn", "Audio/emote/fade/blend/wait-click/avatar Action contract test: PASS"),
	("res://tests/game_avatar_translation_test.tscn", "Game avatar 8-method load/mount/setup/defer direct-translation test: PASS"),
    ("res://tests/pressure_hold_manager_test.tscn", "PressureHoldManager field/load/request/flow/finally direct-translation test: PASS"),
    ("res://tests/pressure_hold_ui_test.tscn", "PressureHoldUI hold/release/cancel/cleanup contract test: PASS"),
    ("res://tests/pressure_hold_integration_test.tscn", "PressureHold Action/UIOverlay/JSON/state direct-translation integration test: PASS"),
	("res://tests/minigame_session_test.tscn", "MinigameSession Promise/lifecycle/order/action-gate direct-translation test: PASS"),
    ("res://tests/paper_craft_integration_test.tscn", "PaperCraft direct-object/layer/drag/score/action/session integration test: PASS"),
	("res://tests/minigame_script_runner_test.tscn", "MinigameScript core/factory/generator/identity direct-translation test: PASS"),
    ("res://tests/sugar_wheel_spin_physics_test.tscn", "SugarWheel spin physics direct API/input/RNG/integration/landing contract test: PASS"),
    ("res://tests/sugar_wheel_atmosphere_test.tscn", "SugarWheel atmosphere direct opcode/RNG/phase/pending/branch contract test: PASS"),
    ("res://tests/sugar_wheel_integration_test.tscn", "SugarWheel direct-field/layer/input/charge/condition/physics/actions/speech/session integration test: PASS"),
	("res://tests/water_entity_test.tscn", "WaterEntity module/field/constructor/depth/motion/tint/input/resource direct-translation test: PASS"),
    ("res://tests/water_pull_panel_test.tscn", "WaterPullPanel direct field/RNG/rhythm/physics/result/graphics-owner contract test: PASS"),
    ("res://tests/water_integration_test.tscn", "Water five-instance/render/pick/pull/failure/degrade/save/action integration test: PASS"),
    ("res://tests/scene_depth_system_test.tscn", "SceneDepth load/shader/collision/floor-zone/actions/unload contract test: PASS"),
    ("res://tests/advanced_rendering_test.tscn", "Advanced rendering filter/pipeline/lighting/planar/deferred/shadow-field integration test: PASS"),
    ("res://tests/shop_ui_test.tscn", "ShopUI 2-def/open/purchase/insufficient/rebuild/close/state Action integration test: PASS"),
    ("res://tests/runtime_panels_test.tscn", "Notification/Pickup/Inventory/Quest/Rules UI data/input/action lifecycle test: PASS"),
    ("res://tests/secondary_panels_test.tscn", "ActionChoice/DialogueLog/RuleUse UI input/data/action lifecycle test: PASS"),
	("res://tests/archive_ui_test.tscn", "Bookshelf factory/return/Rules and archive UI direct-translation test: PASS"),
    ("res://tests/hud_map_menu_test.tscn", "HUD/Smell/Map/Menu shared-data/events/travel/settings lifecycle test: PASS"),
    ("res://tests/dev_touch_ui_test.tscn", "DebugPanel/DevMode/TouchMobileControls shared-state/input lifecycle test: PASS"),
	("res://tests/debug_tools_test.tscn", "DebugTools 14-section/input/render-debug direct-translation test: PASS"),
    ("res://tests/inspect_box_test.tscn", "InspectBox show/re-show/input-close contract test: PASS"),
    ("res://tests/dialogue_ui_test.tscn", "DialogueUI typewriter/advance/choice lifecycle test: PASS"),
    ("res://tests/dialogue_manager_test.tscn", "DialogueManager scripted/nested/end contract test: PASS"),
    ("res://tests/encounter_manager_test.tscn", "EncounterManager field/load/options/resolve/finally direct-translation test: PASS"),
    ("res://tests/audio_manager_test.tscn", "AudioManager module/field/config/epoch/mix/capture/transient/gate/system-SFX/lifecycle direct-translation test: PASS"),
    ("res://tests/emote_bubble_manager_test.tscn", "EmoteBubble module/field/mount/follow/hotspot/sticky/owner/wait/lifecycle direct-translation test: PASS"),
    ("res://tests/encounter_ui_test.tscn", "EncounterUI four-phase/input/choice-lock lifecycle test: PASS"),
    ("res://tests/cutscene_present_test.tscn", "CutsceneRenderer 16-present primitive contract test: PASS"),
    ("res://tests/cutscene_manager_test.tscn", "CutsceneManager session/parallel/policy/skip contract test: PASS"),
    ("res://tests/cutscene_integration_test.tscn", "Real teahouse cutscene Action/audio/present/state integration test: PASS"),
    ("res://tests/bootstrap_on_enter_cutscene_test.tscn", "Bootstrap real scene onEnter-to-cutscene chain test: PASS"),
    ("res://tests/player_path_e2e_test.tscn", "No-debug new-game/dialogue/production-transition player path E2E: PASS"),
    ("res://tests/mainline_opening_arc_e2e_test.tscn", "No-debug 22-scene full mainline/side-path new-game-to-s12_chufa E2E: PASS"),
    ("res://tests/all_cutscenes_smoke_test.tscn", "All 20 cutscene definitions executable/cleanup closure test: PASS"),
    ("res://tests/save_manager_test.tscn", "SaveManager atomic/interoperable test: PASS"),
	("res://tests/data_types_test.tscn", "Data types runtime enum/cutscene-binding/allowlist contract test: PASS"),
    ("res://tests/quest_manager_test.tscn", "QuestManager field/load/evaluate/tail/save/destroy direct-translation test: PASS"),
    ("res://tests/narrative_signal_queue_test.tscn", "Narrative signal queue contract test: PASS"),
	("res://tests/narrative_state_manager_direct_test.tscn", "NarrativeStateManager direct architecture/async/validation test: PASS"),
    ("res://tests/narrative_reactive_test.tscn", "Narrative reactive contract test: PASS"),
    ("res://tests/narrative_owner_save_test.tscn", "Narrative owner/reached/save contract test: PASS"),
    ("res://tests/plane_reconciler_test.tscn", "PlaneReconciler contract test: PASS"),
    ("res://tests/plane_runtime_integration_test.tscn", "Plane runtime entity/zone/camera/movement/lighting binding integration test: PASS"),
	("res://tests/live_condition_provider_test.tscn", "Live 9-node condition provider direct-translation test: PASS"),
    ("res://tests/day_manager_test.tscn", "DayManager contract test: PASS"),
	("res://tests/health_system_test.tscn", "HealthSystem field/order/tether/error direct-translation test: PASS"),
	("res://tests/signal_cue_manager_test.tscn", "SignalCueManager field/method/load/play direct-translation test: PASS"),
    ("res://tests/archive_manager_test.tscn", "ArchiveManager contract test: PASS"),
    ("res://tests/document_reveal_manager_test.tscn", "DocumentRevealManager direct field/load/condition/reentry/failure/save contract test: PASS"),
    ("res://tests/renderer_test.tscn", "Renderer layer/resize lifecycle test: PASS"),
	("res://tests/filter_loader_test.tscn", "Filter types/loader validation/cache/material translation test: PASS"),
    ("res://tests/sprite_entity_test.tscn", "SpriteEntity 46-manifest atlas contract test: PASS"),
    ("res://tests/player_test.tscn", "Player movement/cutscene/modifier contract test: PASS"),
    ("res://tests/npc_test.tscn", "Npc registry/visibility/movement/patrol contract test: PASS"),
    ("res://tests/hotspot_test.tscn", "Hotspot five-type/display/visibility/collision contract test: PASS"),
	("res://tests/hotspot_collision_test.tscn", "Hotspot collision anchor/hotspot/runtime-NPC translation test: PASS"),
    ("res://tests/scene_manager_test.tscn", "SceneManager all-scene JSON/asset/instantiate contract test: PASS"),
    ("res://tests/scene_memory_test.tscn", "SceneManager spawn/transition/memory/override contract test: PASS"),
    ("res://tests/scene_on_enter_test.tscn", "Scene ready/reveal/onEnter/reentrant-switch contract test: PASS"),
    ("res://tests/interaction_system_test.tscn", "InteractionSystem source-order/distance/condition/plane/auto-trigger direct-translation test: PASS"),
    ("res://tests/interaction_coordinator_test.tscn", "InteractionCoordinator inspect/pickup/transition/npc/encounter routing test: PASS"),
	("res://tests/zone_system_test.tscn", "ZoneSystem diff/tail/reference/geometry direct-translation test: PASS"),
    ("res://tests/graph_dialogue_manager_test.tscn", "GraphDialogueManager seven-node/all-graph contract test: PASS"),
    ("res://tests/dialogue_integration_test.tscn", "NPC real-JSON dialogue/UI/state/camera integration test: PASS"),
    ("res://tests/scripted_dialogue_integration_test.tscn", "playScriptedDialogue Action/UI/context integration test: PASS"),
    ("res://tests/encounter_integration_test.tscn", "Hotspot real encounter/UI/reward/state integration test: PASS"),
    ("res://tests/core_lifecycle_stress_test.tscn", "Core lifecycle stress test: PASS"),
]


def run(
    command: list[str],
    marker: str,
    *,
    allow_intentional_listener_error: bool = False,
    expected_warnings: dict[str, int] | None = None,
    expected_errors: dict[str, int] | None = None,
) -> None:
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=150,
        check=False,
    )
    output = result.stdout + result.stderr
    script_error = "SCRIPT ERROR:" in output
    if allow_intentional_listener_error and "intentional listener failure probe" in output:
        script_error = False
    # reportDevError deliberately uses Godot's error console just like console.error.
    # Exact expected diagnostics remain fail-closed by message and count.
    error_lines = [line for line in output.splitlines() if line.startswith("ERROR:")]
    expected_errors = expected_errors or {}
    unexpected_errors = [
        line for line in error_lines
        if not any(fragment in line for fragment in expected_errors)
    ]
    wrong_error_counts = {
        fragment: (expected, sum(fragment in line for line in error_lines))
        for fragment, expected in expected_errors.items()
        if sum(fragment in line for line in error_lines) != expected
    }
    bad_error = script_error or bool(unexpected_errors or wrong_error_counts)
    leak_markers = (
        "ObjectDB instances leaked at exit",
        "Resources still in use at exit",
        "RID allocations leaked at exit",
        "Orphan StringName",
    )
    warning_lines = [line for line in output.splitlines() if line.startswith("WARNING:")]
    expected_warnings = expected_warnings or {}
    unexpected_warnings = [
        line for line in warning_lines
        if not any(fragment in line for fragment in expected_warnings)
    ]
    wrong_warning_counts = {
        fragment: (expected, sum(fragment in line for line in warning_lines))
        for fragment, expected in expected_warnings.items()
        if sum(fragment in line for line in warning_lines) != expected
    }
    bad_warning = bool(unexpected_warnings or wrong_warning_counts)
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

    run([sys.executable, str(PORT_ROOT / "tools/audit_architecture_parity.py")], "Architecture parity audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_temporary_bypasses.py")], "Temporary bypass audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_dialogue_graphs.py")], "Dialogue graph route audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_scene_routes.py")], "Scene route topology audit: PASS")
    run([sys.executable, str(PORT_ROOT / "tools/audit_content_warnings.py")], "Content warning fallback classification: PASS")
    run([godot, "--headless", "--path", str(PORT_ROOT), "--import"], "[ DONE ]")
    for path, marker in SCRIPT_TESTS:
        run(
            [godot, "--headless", "--path", str(PORT_ROOT), "--script", path],
            marker,
            expected_warnings=EXPECTED_WARNINGS.get(path),
            expected_errors=EXPECTED_ERRORS.get(path),
        )
    run(
        [godot, "--headless", "--path", str(PORT_ROOT), "--script", "res://tests/event_bus_error_probe.gd"],
        "EventBus listener isolation probe: PASS",
        allow_intentional_listener_error=True,
    )
    for path, marker in SCENE_TESTS:
        run(
            [godot, "--headless", "--path", str(PORT_ROOT), "--scene", path],
            marker,
            expected_warnings=EXPECTED_WARNINGS.get(path),
            expected_errors=EXPECTED_ERRORS.get(path),
        )
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
