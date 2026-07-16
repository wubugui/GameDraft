extends Node

const GameHarnessScript := preload("res://tests/support/scene_lifecycle_game_harness.gd")

const SCENE_ID := "test_room_a"
const TARGET_NPC_ID := "npc_ringboy"
const OTHER_NPC_ID := "new_npc_1"
const TARGET_HOTSPOT_ID := "new_hotspot_9"
const OTHER_HOTSPOT_ID := "new_hotspot_10"


func _ready() -> void:
	await _run_contract()
	print("Game entitiesRebuilt targeted shadow/filter identity direct-translation test: PASS")
	get_tree().quit(0)


func _run_contract() -> void:
	var game: Node = GameHarnessScript.new()
	game.set_meta("suppressSceneOnEnter", true)
	add_child(game)
	await _wait_until_runtime_ready(game)

	# Audio is outside this contract.  Disable scene audio before loading the
	# fixture so teardown leak checks only cover the entity lifecycle under test.
	game.audio_manager.stop_all_playback()
	game.scene_manager.set_audio_applier()
	await get_tree().process_frame
	game.scene_manager.unload_scene()
	assert(await game.scene_manager.load_scene(SCENE_ID), "fixture scene failed to load")
	# The contract drives updateEntityShadows explicitly.  Keep Game's natural
	# tick out of the manual replacement window so no half-rebuilt list can be
	# observed between the SceneManager-side swap and the emitted event.
	game.set_process(false)

	# Scene ready starts every eligible patrol.  Freeze the baseline so the
	# enter/exit assertions observe only scene:entitiesRebuilt's phase policy.
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		game.stop_npc_patrol(npc.get_id())

	var target_npc: RuntimeNpc = game.scene_manager.get_npc_by_id(TARGET_NPC_ID)
	var other_npc: RuntimeNpc = game.scene_manager.get_npc_by_id(OTHER_NPC_ID)
	var target_hotspot := _hotspot_by_id(game, TARGET_HOTSPOT_ID)
	var other_hotspot := _hotspot_by_id(game, OTHER_HOTSPOT_ID)
	assert(target_npc != null and other_npc != null, "fixture NPCs missing")
	assert(target_hotspot != null and other_hotspot != null, "fixture hotspots missing")
	assert(target_npc.def.get("patrol") is Dictionary, "target NPC must have a patrol")

	var checks: Dictionary = {}
	checks["initial entries carry shadow/src/owner"] = _all_shadow_entries_have_source_owner(game)

	var player_entry: Dictionary = game.entity_shadows.get("player", {})
	var target_npc_entry: Dictionary = game.entity_shadows.get(TARGET_NPC_ID, {})
	var other_npc_entry: Dictionary = game.entity_shadows.get(OTHER_NPC_ID, {})
	var target_hotspot_key := "hotspot:%s" % TARGET_HOTSPOT_ID
	var other_hotspot_key := "hotspot:%s" % OTHER_HOTSPOT_ID
	var target_hotspot_entry: Dictionary = game.entity_shadows.get(target_hotspot_key, {})
	var other_hotspot_entry: Dictionary = game.entity_shadows.get(other_hotspot_key, {})
	assert(not player_entry.is_empty(), "player shadow entry missing")
	assert(not target_npc_entry.is_empty() and not other_npc_entry.is_empty(), "fixture NPC shadow entries missing")
	assert(not target_hotspot_entry.is_empty() and not other_hotspot_entry.is_empty(), "fixture hotspot shadow entries missing")
	var player_identity := _capture_entry_identity(player_entry)
	var other_npc_identity := _capture_entry_identity(other_npc_entry)
	var other_hotspot_identity := _capture_entry_identity(other_hotspot_entry)

	var player_filter: Variant = game.player_depth_filter
	var other_npc_filter: Variant = RuntimeSceneEntityFilterBinding.get_filter(other_npc.container)
	var other_hotspot_filter: Variant = other_hotspot.get_depth_occlusion_filter()
	assert(player_filter != null and other_npc_filter != null and other_hotspot_filter != null, "fixture filters missing")

	# Mirror SceneManager's rebuild ownership boundary: it destroys the selected
	# old entities and filters, installs fresh instances, then emits the event.
	var enter_npc_swap := _replace_npc_without_event(game, TARGET_NPC_ID)
	var enter_hotspot_swap := _replace_hotspot_without_event(game, TARGET_HOTSPOT_ID)
	_sync_interaction_entities(game)
	var enter_npc: RuntimeNpc = enter_npc_swap.replacement
	var enter_hotspot: RuntimeHotspot = enter_hotspot_swap.replacement
	var old_enter_npc_shadow: Variant = target_npc_entry.shadow
	var old_enter_hotspot_shadow: Variant = target_hotspot_entry.shadow
	var old_enter_npc_shadow_id: int = old_enter_npc_shadow.get_instance_id()
	var old_enter_hotspot_shadow_id: int = old_enter_hotspot_shadow.get_instance_id()

	game.event_bus.emit("scene:entitiesRebuilt", {
		"cutsceneId": "identity_contract",
		"phase": "enter",
		"npcIds": [TARGET_NPC_ID],
		"hotspotIds": [TARGET_HOTSPOT_ID],
	})

	var enter_npc_entry: Dictionary = game.entity_shadows.get(TARGET_NPC_ID, {})
	var enter_hotspot_entry: Dictionary = game.entity_shadows.get(target_hotspot_key, {})
	checks["enter does not restart patrol"] = not enter_npc.is_moving_to_target()
	checks["enter selected NPC filter replaced"] = enter_npc_swap.old_filter.destroyed \
		and not game.scene_depth_system.filters.has(enter_npc_swap.old_filter) \
		and RuntimeSceneEntityFilterBinding.get_filter(enter_npc.container) != null \
		and not is_same(RuntimeSceneEntityFilterBinding.get_filter(enter_npc.container), enter_npc_swap.old_filter)
	checks["enter selected hotspot filter replaced"] = enter_hotspot_swap.old_filter.destroyed \
		and not game.scene_depth_system.filters.has(enter_hotspot_swap.old_filter) \
		and enter_hotspot.get_depth_occlusion_filter() != null \
		and not is_same(enter_hotspot.get_depth_occlusion_filter(), enter_hotspot_swap.old_filter)
	checks["enter selected NPC shadow unregister/destroy/replace"] = old_enter_npc_shadow.root == null \
		and not game.scene_depth_system.shadows.has(old_enter_npc_shadow_id) \
		and not enter_npc_entry.is_empty() \
		and not is_same(enter_npc_entry.shadow, old_enter_npc_shadow) \
		and is_same(enter_npc_entry.owner, enter_npc) \
		and not is_same(enter_npc_entry.src, target_npc_entry.src)
	checks["enter selected hotspot shadow unregister/destroy/replace"] = old_enter_hotspot_shadow.root == null \
		and not game.scene_depth_system.shadows.has(old_enter_hotspot_shadow_id) \
		and not enter_hotspot_entry.is_empty() \
		and not is_same(enter_hotspot_entry.shadow, old_enter_hotspot_shadow) \
		and is_same(enter_hotspot_entry.owner, enter_hotspot) \
		and not is_same(enter_hotspot_entry.src, target_hotspot_entry.src)
	checks["enter preserves player shadow/filter identity"] = _entry_identity_unchanged(game.entity_shadows.get("player"), player_identity) \
		and is_same(game.player_depth_filter, player_filter) \
		and is_same(RuntimeSceneEntityFilterBinding.get_filter(game.player.sprite.container), player_filter)
	checks["enter preserves unlisted NPC shadow/filter identity"] = _entry_identity_unchanged(game.entity_shadows.get(OTHER_NPC_ID), other_npc_identity) \
		and is_same(RuntimeSceneEntityFilterBinding.get_filter(other_npc.container), other_npc_filter)
	checks["enter preserves unlisted hotspot shadow/filter identity"] = _entry_identity_unchanged(game.entity_shadows.get(other_hotspot_key), other_hotspot_identity) \
		and is_same(other_hotspot.get_depth_occlusion_filter(), other_hotspot_filter)
	checks["enter replacement entries carry shadow/src/owner"] = _entry_has_source_owner(enter_npc_entry) \
		and _entry_has_source_owner(enter_hotspot_entry)

	# Exit rebuilds the same ids again.  Only exit is allowed to restart an
	# eligible patrol; the targeted shadow/filter replacement rules stay equal.
	var exit_npc_swap := _replace_npc_without_event(game, TARGET_NPC_ID)
	var exit_hotspot_swap := _replace_hotspot_without_event(game, TARGET_HOTSPOT_ID)
	_sync_interaction_entities(game)
	var exit_npc: RuntimeNpc = exit_npc_swap.replacement
	var exit_hotspot: RuntimeHotspot = exit_hotspot_swap.replacement
	var old_exit_npc_entry: Dictionary = enter_npc_entry
	var old_exit_hotspot_entry: Dictionary = enter_hotspot_entry
	var old_exit_npc_shadow: Variant = old_exit_npc_entry.shadow
	var old_exit_hotspot_shadow: Variant = old_exit_hotspot_entry.shadow
	var old_exit_npc_shadow_id: int = old_exit_npc_shadow.get_instance_id()
	var old_exit_hotspot_shadow_id: int = old_exit_hotspot_shadow.get_instance_id()

	game.event_bus.emit("scene:entitiesRebuilt", {
		"cutsceneId": "identity_contract",
		"phase": "exit",
		"npcIds": [TARGET_NPC_ID],
		"hotspotIds": [TARGET_HOTSPOT_ID],
	})

	var exit_npc_entry: Dictionary = game.entity_shadows.get(TARGET_NPC_ID, {})
	var exit_hotspot_entry: Dictionary = game.entity_shadows.get(target_hotspot_key, {})
	checks["exit restarts eligible patrol"] = exit_npc.is_moving_to_target()
	checks["exit selected filters replaced"] = exit_npc_swap.old_filter.destroyed \
		and exit_hotspot_swap.old_filter.destroyed \
		and RuntimeSceneEntityFilterBinding.get_filter(exit_npc.container) != null \
		and not is_same(RuntimeSceneEntityFilterBinding.get_filter(exit_npc.container), exit_npc_swap.old_filter) \
		and exit_hotspot.get_depth_occlusion_filter() != null \
		and not is_same(exit_hotspot.get_depth_occlusion_filter(), exit_hotspot_swap.old_filter)
	checks["exit selected shadows unregister/destroy/replace"] = old_exit_npc_shadow.root == null \
		and old_exit_hotspot_shadow.root == null \
		and not game.scene_depth_system.shadows.has(old_exit_npc_shadow_id) \
		and not game.scene_depth_system.shadows.has(old_exit_hotspot_shadow_id) \
		and not is_same(exit_npc_entry.shadow, old_exit_npc_shadow) \
		and not is_same(exit_hotspot_entry.shadow, old_exit_hotspot_shadow) \
		and is_same(exit_npc_entry.owner, exit_npc) \
		and is_same(exit_hotspot_entry.owner, exit_hotspot) \
		and not is_same(exit_npc_entry.src, old_exit_npc_entry.src) \
		and not is_same(exit_hotspot_entry.src, old_exit_hotspot_entry.src)
	checks["exit still preserves nonpayload identities"] = _entry_identity_unchanged(game.entity_shadows.get("player"), player_identity) \
		and _entry_identity_unchanged(game.entity_shadows.get(OTHER_NPC_ID), other_npc_identity) \
		and _entry_identity_unchanged(game.entity_shadows.get(other_hotspot_key), other_hotspot_identity) \
		and is_same(game.player_depth_filter, player_filter) \
		and is_same(RuntimeSceneEntityFilterBinding.get_filter(other_npc.container), other_npc_filter) \
		and is_same(other_hotspot.get_depth_occlusion_filter(), other_hotspot_filter)

	# updateEntityShadows reuses a cached source while owner identity is stable.
	# If an entity instance changes without an entitiesRebuilt event, it swaps
	# only owner/src in the existing entry and keeps the shadow implementation.
	var player_src: Variant = player_entry.src
	var other_npc_src: Variant = other_npc_entry.src
	var other_hotspot_src: Variant = other_hotspot_entry.src
	game.update_entity_shadows()
	game.update_entity_shadows()
	checks["update caches stable player/NPC/hotspot sources"] = is_same(player_entry.src, player_src) \
		and is_same(other_npc_entry.src, other_npc_src) \
		and is_same(other_hotspot_entry.src, other_hotspot_src)

	var cached_npc_shadow: Variant = other_npc_entry.shadow
	var cached_hotspot_shadow: Variant = other_hotspot_entry.shadow
	var cached_npc_shadow_id: int = cached_npc_shadow.get_instance_id()
	var cached_hotspot_shadow_id: int = cached_hotspot_shadow.get_instance_id()
	var owner_swap_npc := _replace_npc_without_event(game, OTHER_NPC_ID)
	var owner_swap_hotspot := _replace_hotspot_without_event(game, OTHER_HOTSPOT_ID)
	_sync_interaction_entities(game)
	game.update_entity_shadows()
	checks["update owner swap changes only NPC owner/src"] = is_same(game.entity_shadows.get(OTHER_NPC_ID), other_npc_entry) \
		and is_same(other_npc_entry.shadow, cached_npc_shadow) \
		and is_same(other_npc_entry.owner, owner_swap_npc.replacement) \
		and not is_same(other_npc_entry.src, other_npc_src) \
		and game.scene_depth_system.shadows.has(cached_npc_shadow_id)
	checks["update owner swap changes only hotspot owner/src"] = is_same(game.entity_shadows.get(other_hotspot_key), other_hotspot_entry) \
		and is_same(other_hotspot_entry.shadow, cached_hotspot_shadow) \
		and is_same(other_hotspot_entry.owner, owner_swap_hotspot.replacement) \
		and not is_same(other_hotspot_entry.src, other_hotspot_src) \
		and game.scene_depth_system.shadows.has(cached_hotspot_shadow_id)
	var owner_swapped_npc_identity := _capture_entry_identity(other_npc_entry)
	var owner_swapped_hotspot_identity := _capture_entry_identity(other_hotspot_entry)

	# A payload id can be absent by the time the listener runs (for example a
	# cutscene-only entity removed on exit).  Its stale entry must still die,
	# without manufacturing a replacement or bumping a nonexistent patrol.
	game.stop_npc_patrol(TARGET_NPC_ID)
	var missing_epoch := int(game.npc_patrol_epoch.get(TARGET_NPC_ID, 0))
	var missing_npc_shadow: Variant = exit_npc_entry.shadow
	var missing_hotspot_shadow: Variant = exit_hotspot_entry.shadow
	var missing_npc_shadow_id: int = missing_npc_shadow.get_instance_id()
	var missing_hotspot_shadow_id: int = missing_hotspot_shadow.get_instance_id()
	_remove_npc_without_event(game, TARGET_NPC_ID)
	_remove_hotspot_without_event(game, TARGET_HOTSPOT_ID)
	_sync_interaction_entities(game)
	game.event_bus.emit("scene:entitiesRebuilt", {
		"cutsceneId": "identity_contract",
		"phase": "exit",
		"npcIds": [TARGET_NPC_ID],
		"hotspotIds": [TARGET_HOTSPOT_ID],
	})
	checks["missing payload ids clear stale entries only"] = not game.entity_shadows.has(TARGET_NPC_ID) \
		and not game.entity_shadows.has(target_hotspot_key) \
		and missing_npc_shadow.root == null \
		and missing_hotspot_shadow.root == null \
		and not game.scene_depth_system.shadows.has(missing_npc_shadow_id) \
		and not game.scene_depth_system.shadows.has(missing_hotspot_shadow_id)
	checks["missing NPC does not stop or restart patrol"] = int(game.npc_patrol_epoch.get(TARGET_NPC_ID, 0)) == missing_epoch
	checks["missing-id cleanup preserves remaining entries"] = _entry_identity_unchanged(game.entity_shadows.get("player"), player_identity) \
		and _entry_identity_unchanged(game.entity_shadows.get(OTHER_NPC_ID), owner_swapped_npc_identity) \
		and _entry_identity_unchanged(game.entity_shadows.get(other_hotspot_key), owner_swapped_hotspot_identity) \
		and _all_shadow_entries_have_source_owner(game)

	await _cleanup(game)
	for label: String in checks:
		assert(checks[label], label)


func _wait_until_runtime_ready(game: Node) -> void:
	var frames := 0
	while not game.runtime_ready and frames < 600:
		frames += 1
		await get_tree().process_frame
	assert(game.runtime_ready, "bootstrap did not finish within 600 frames")


func _hotspot_by_id(game: Node, id: String) -> RuntimeHotspot:
	for hotspot: RuntimeHotspot in game.scene_manager.get_current_hotspots():
		if hotspot.get_id() == id:
			return hotspot
	return null


func _replace_npc_without_event(game: Node, id: String) -> Dictionary:
	var npcs: Array[RuntimeNpc] = game.scene_manager.current_npcs
	var index := npcs.find_custom(func(npc: RuntimeNpc) -> bool: return npc.get_id() == id)
	assert(index >= 0, "cannot replace missing NPC %s" % id)
	var old: RuntimeNpc = npcs[index]
	var definition := old.def.duplicate(true)
	var old_filter: Variant = RuntimeSceneEntityFilterBinding.get_filter(old.container)
	assert(old_filter != null, "NPC %s must have a filter before rebuild" % id)
	game.scene_manager._release_npc_filters(old)
	old.destroy_npc()
	var replacement: RuntimeNpc = game.scene_manager._instantiate_npc(definition, null)
	game.scene_manager.current_npcs[index] = replacement
	return {"old": old, "old_filter": old_filter, "replacement": replacement}


func _replace_hotspot_without_event(game: Node, id: String) -> Dictionary:
	var hotspots: Array[RuntimeHotspot] = game.scene_manager.current_hotspots
	var index := hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == id)
	assert(index >= 0, "cannot replace missing hotspot %s" % id)
	var old: RuntimeHotspot = hotspots[index]
	var definition := old.def.duplicate(true)
	var old_filter: Variant = old.get_depth_occlusion_filter()
	assert(old_filter != null, "hotspot %s must have a filter before rebuild" % id)
	game.scene_manager._release_hotspot_filters(old)
	old.destroy_hotspot()
	var replacement: RuntimeHotspot = game.scene_manager._instantiate_hotspot(definition, null)
	game.scene_manager.current_hotspots[index] = replacement
	return {"old": old, "old_filter": old_filter, "replacement": replacement}


func _remove_npc_without_event(game: Node, id: String) -> void:
	var index: int = game.scene_manager.current_npcs.find_custom(func(npc: RuntimeNpc) -> bool: return npc.get_id() == id)
	assert(index >= 0, "cannot remove missing NPC %s" % id)
	var npc: RuntimeNpc = game.scene_manager.current_npcs[index]
	game.scene_manager._release_npc_filters(npc)
	npc.destroy_npc()
	game.scene_manager.current_npcs.remove_at(index)


func _remove_hotspot_without_event(game: Node, id: String) -> void:
	var index: int = game.scene_manager.current_hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == id)
	assert(index >= 0, "cannot remove missing hotspot %s" % id)
	var hotspot: RuntimeHotspot = game.scene_manager.current_hotspots[index]
	game.scene_manager._release_hotspot_filters(hotspot)
	hotspot.destroy_hotspot()
	game.scene_manager.current_hotspots.remove_at(index)


func _sync_interaction_entities(game: Node) -> void:
	game.interaction_system.set_hotspots(game.scene_manager.get_current_hotspots())
	game.interaction_system.set_npcs(game.scene_manager.get_current_npcs())


func _entry_has_source_owner(value: Variant) -> bool:
	return value is Dictionary \
		and value.has("shadow") and value.shadow != null \
		and value.has("src") and value.src != null \
		and value.has("owner") and value.owner != null


func _all_shadow_entries_have_source_owner(game: Node) -> bool:
	if game.entity_shadows.is_empty():
		return false
	for entry: Variant in game.entity_shadows.values():
		if not _entry_has_source_owner(entry):
			return false
	return true


func _capture_entry_identity(entry: Dictionary) -> Dictionary:
	return {
		"entry": entry,
		"shadow": entry.shadow,
		"src": entry.src,
		"owner": entry.owner,
	}


func _entry_identity_unchanged(current: Variant, expected: Dictionary) -> bool:
	return current is Dictionary \
		and is_same(current, expected.entry) \
		and is_same(current.shadow, expected.shadow) \
		and is_same(current.src, expected.src) \
		and is_same(current.owner, expected.owner)


func _cleanup(game: Node) -> void:
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		game.stop_npc_patrol(npc.get_id())
	game.audio_manager.stop_all_playback()
	game.asset_manager.clear_cache()
	# Flush queued shadow roots and stopped AudioStreamPlayers while their owners
	# still exist, then run Game.destroy's normal reverse lifecycle.
	await get_tree().process_frame
	game.destroy()
	remove_child(game)
	game.free()
	await get_tree().create_timer(0.5).timeout
