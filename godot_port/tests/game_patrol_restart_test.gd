extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap := BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	for _index in 120:
		if bootstrap.runtime_ready:
			break
		await get_tree().process_frame
	assert(bootstrap.runtime_ready)
	assert(await bootstrap.scene_manager.switch_scene("test_room_a"))
	var npc: RuntimeNpc = bootstrap.scene_manager.get_npc_by_id("npc_ringboy")
	assert(npc != null and npc.def.get("patrol") is Dictionary)

	bootstrap.stop_npc_patrol(npc.get_id())
	var epoch := int(bootstrap.npc_patrol_epoch.get(npc.get_id(), 0))
	bootstrap._apply_npc_runtime_field_now(npc.get_id(), "patrolDisabled", false)
	assert(int(bootstrap.npc_patrol_epoch.get(npc.get_id(), 0)) == epoch + 1)
	epoch += 1
	bootstrap._apply_npc_runtime_field_now(npc.get_id(), "patrolDisabled", false)
	assert(int(bootstrap.npc_patrol_epoch.get(npc.get_id(), 0)) == epoch + 1)
	epoch += 1
	npc.set_visible(false)
	bootstrap._apply_npc_runtime_field_now(npc.get_id(), "patrolDisabled", false)
	assert(int(bootstrap.npc_patrol_epoch.get(npc.get_id(), 0)) == epoch + 1)
	assert(npc.def.get("patrolDisabled") == false)

	bootstrap.stop_npc_patrol(npc.get_id())
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	bootstrap.destroy()
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Game patrolDisabled false stop-before-restart direct-translation test: PASS")
	get_tree().quit(0)
