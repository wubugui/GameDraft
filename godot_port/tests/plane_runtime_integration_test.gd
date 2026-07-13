extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame; await get_tree().process_frame
	assert(bootstrap.plane_reconciler.activate_plane_manually("normal")); assert(bootstrap.scene_manager.load_scene("雾津街头", "", null, null, false)); await get_tree().process_frame
	var normal_only: RuntimeHotspot = bootstrap.scene_manager.get_hotspot_by_id("T_进茶馆"); var shared: RuntimeHotspot = bootstrap.scene_manager.get_hotspot_by_id("T_去义庄")
	assert(normal_only != null and bootstrap.scene_manager.get_hotspot_base_enabled_for_interaction(normal_only) and shared != null and bootstrap.scene_manager.get_hotspot_base_enabled_for_interaction(shared))
	var normal_zone_ids: Array = bootstrap.zone_system.zones.map(func(zone: Dictionary) -> String: return str(zone.id))
	assert(normal_zone_ids.has("z_梦待死之礼") and normal_zone_ids.has("z_淹尸_水腥") and not normal_zone_ids.has("z_背尸_水汽_远"))
	assert(bootstrap.plane_reconciler.activate_plane_manually("背尸")); await get_tree().process_frame
	assert(not bootstrap.scene_manager.get_hotspot_base_enabled_for_interaction(normal_only) and bootstrap.scene_manager.get_hotspot_base_enabled_for_interaction(shared) and is_equal_approx(bootstrap.camera.get_zoom(), 1.25))
	var carry_zone_ids: Array = bootstrap.zone_system.zones.map(func(zone: Dictionary) -> String: return str(zone.id))
	assert(not carry_zone_ids.has("z_梦待死之礼") and carry_zone_ids.has("z_淹尸_水腥") and carry_zone_ids.has("z_背尸_水汽_远"))
	assert(bootstrap.player._movement_modifier.call().get("allowRun") == false)
	bootstrap.plane_reconciler.register_defs([{"id": "normal"}, {"id": "lit", "lighting": {"key": {"color": [0.2, 0.4, 0.8], "intensity": 0.5}, "shadow": {"mode": "off"}}}])
	assert(bootstrap.plane_reconciler.activate_plane_manually("lit")); await get_tree().process_frame
	var material: ShaderMaterial = bootstrap.player.sprite.sprite.material; assert(material.get_shader_parameter("key_color") == Vector3(0.2, 0.4, 0.8) and is_equal_approx(float(material.get_shader_parameter("key_intensity")), 0.5) and bootstrap.scene_depth_system.get_shadow_count() == 0)
	bootstrap.plane_reconciler.deactivate_manual_plane(); await get_tree().process_frame
	assert(bootstrap.scene_depth_system.light_env.get("shadow", {}).get("mode") == "real" and bootstrap.scene_depth_system.get_shadow_count() >= 1)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("Plane runtime entity/zone/camera/movement/lighting binding integration test: PASS"); get_tree().quit(0)
