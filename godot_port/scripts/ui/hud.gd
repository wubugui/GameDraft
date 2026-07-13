class_name RuntimeHUD
extends RefCounted

const HudFlame := preload("res://scripts/ui/hud_flame.gd")

var renderer: RuntimeRenderer
var events: RuntimeEventBus
var strings: RuntimeStringsProvider
var root := Control.new()
var coin_bg := Panel.new()
var coin := Label.new()
var quest_bg := Panel.new()
var quest := Label.new()
var map_name := Label.new()
var rule_hint_bg := Panel.new()
var rule_hint := Label.new()
var flames: Array[Node2D] = []
var smell: RuntimeSmellIndicatorRenderer
var tracked: Array[Dictionary] = []
var health_ratio := 1.0
var flame_display_ratio := 1.0
var flame_time := 0.0
var _resolve_display := Callable()
var _resize_unsubscribe := Callable()


func _init(next_renderer: RuntimeRenderer, event_bus: RuntimeEventBus, next_strings: RuntimeStringsProvider, smell_data: Dictionary) -> void:
	renderer = next_renderer
	events = event_bus
	strings = next_strings
	root.name = "HUD"
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	renderer.ui_layer.add_child(root)

	_configure_panel(coin_bg)
	coin_bg.position = Vector2(10, 10)
	coin_bg.size = Vector2(120, 28)
	root.add_child(coin_bg)
	coin.text = "%s 0" % strings.get_text("hud", "coins")
	coin.position = Vector2(20, 15)
	coin.size = Vector2(200, 20)
	coin.add_theme_font_size_override("font_size", 13)
	coin.add_theme_color_override("font_color", Color("ffcc66"))
	root.add_child(coin)

	_configure_panel(quest_bg)
	quest_bg.visible = false
	root.add_child(quest_bg)
	quest.size = Vector2(220, 20)
	quest.add_theme_font_size_override("font_size", 12)
	quest.add_theme_color_override("font_color", Color("aaaacc"))
	root.add_child(quest)

	map_name.size = Vector2(renderer.get_screen_width(), 30)
	map_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	map_name.position.y = 10
	map_name.add_theme_font_size_override("font_size", 12)
	map_name.add_theme_color_override("font_color", Color("8888aa"))
	root.add_child(map_name)

	_configure_panel(rule_hint_bg)
	rule_hint_bg.visible = false
	root.add_child(rule_hint_bg)
	rule_hint.text = strings.get_text("hud", "ruleUseHint")
	rule_hint.size = Vector2(150, 22)
	rule_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	rule_hint.add_theme_font_size_override("font_size", 13)
	rule_hint.add_theme_color_override("font_color", Color("e09a52"))
	rule_hint.visible = false
	root.add_child(rule_hint)

	for index in 3:
		var flame := HudFlame.new(index * 2.1 + 0.7)
		flame.position = Vector2(16 + index * 18, 70)
		root.add_child(flame)
		flames.push_back(flame)

	smell = RuntimeSmellIndicatorRenderer.new(root, smell_data, Vector2(34, 160))
	_layout()
	_resize_unsubscribe = renderer.subscribe_after_resize(Callable(self, "_layout"))
	_listen()


func set_resolve_display(resolver: Callable = Callable()) -> void:
	_resolve_display = resolver
	_refresh_quest_hint()


func set_coins(value: Variant) -> void:
	coin.text = "%s %s" % [strings.get_text("hud", "coins"), value]
	coin_bg.size = Vector2(_text_width(coin) + 20, 28)


func set_active_quests(entries: Array) -> void:
	tracked.clear()
	for entry: Variant in entries:
		if not entry is Dictionary: continue
		var definition: Variant = entry.get("def", entry)
		if not definition is Dictionary: continue
		tracked.push_back({"id": str(definition.get("id", "")), "title": str(definition.get("title", ""))})
	_refresh_quest_hint()


func update(dt: float) -> void:
	flame_time += dt
	var difference := health_ratio - flame_display_ratio
	flame_display_ratio += difference * (1.0 - exp(-dt * 12.0))
	if absf(health_ratio - flame_display_ratio) < 0.001:
		flame_display_ratio = health_ratio
	smell.update(dt)
	for index in flames.size():
		var intensity := clampf(flame_display_ratio * 3.0 - index, 0.0, 1.0)
		flames[index].set_flame_state(intensity, index * 2.1 + 0.7, flame_display_ratio, flame_time)


func reset_animation_clock() -> void:
	flame_time = 0.0
	flame_display_ratio = health_ratio
	if smell != null:
		smell.reset_animation_clock()
	update(0.0)


func get_debug_visual_state() -> Dictionary:
	var flame_states: Array = []
	for flame: Node2D in flames:
		flame_states.push_back(flame.get_debug_state())
	return {
		"flameTime": flame_time,
		"flameTargetRatio": health_ratio,
		"flameDisplayRatio": flame_display_ratio,
		"flames": flame_states,
		"smell": smell.get_debug_state() if smell != null else null,
	}


func destroy() -> void:
	for pair: Array in _pairs(): events.off(pair[0], Callable(self, pair[1]))
	if not _resize_unsubscribe.is_null() and _resize_unsubscribe.is_valid(): _resize_unsubscribe.call()
	_resize_unsubscribe = Callable()
	_resolve_display = Callable()
	if smell != null: smell.destroy()
	if is_instance_valid(root): root.free()


func _configure_panel(panel: Panel) -> void:
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color("130f0a"); style.bg_color.a = 0.8
	style.border_color = Color("574733")
	style.set_border_width_all(1)
	style.set_corner_radius_all(4)
	panel.add_theme_stylebox_override("panel", style)


func _layout() -> void:
	var width := renderer.get_screen_width()
	var height := renderer.get_screen_height()
	map_name.size.x = width
	quest_bg.position = Vector2(width - quest_bg.size.x - 10, 10)
	quest.position = Vector2(width - quest_bg.size.x, 15)
	rule_hint_bg.position = Vector2((width - 160) / 2.0, height - 50)
	rule_hint_bg.size = Vector2(160, 28)
	rule_hint.position = Vector2((width - 150) / 2.0, height - 45)


func _text_width(label: Label) -> float:
	return label.get_theme_font("font").get_string_size(label.text, HORIZONTAL_ALIGNMENT_LEFT, -1, label.get_theme_font_size("font_size")).x


func _display(raw: String) -> String:
	return str(_resolve_display.call(raw)) if not _resolve_display.is_null() and _resolve_display.is_valid() else raw


func _refresh_quest_hint() -> void:
	if tracked.is_empty():
		quest.text = ""
		quest_bg.visible = false
		_layout()
		return
	quest.text = "%s%s" % [strings.get_text("hud", "current"), _display(str(tracked[-1].title))]
	quest_bg.size = Vector2(_text_width(quest) + 20, 28)
	quest_bg.visible = true
	_layout()


func _listen() -> void:
	for pair: Array in _pairs(): events.on(pair[0], Callable(self, pair[1]))


func _pairs() -> Array:
	return [["scene:enter", "_scene"], ["currency:changed", "_currency"], ["quest:accepted", "_quest_add"], ["quest:completed", "_quest_done"], ["save:restoring", "_restore"], ["zone:ruleAvailable", "_rule_on"], ["zone:ruleUnavailable", "_rule_off"], ["player:healthChanged", "_health"], ["debug:hudHealthOverrideChanged", "_health_debug"], ["player:smellChanged", "_smell"], ["player:smellSniff", "_sniff"]]


func _scene(payload: Variant) -> void:
	if payload is Dictionary: map_name.text = _display(str(payload.get("sceneName", payload.get("sceneId", ""))))


func _currency(payload: Variant) -> void:
	if payload is Dictionary: set_coins(payload.get("newTotal", 0))


func _quest_add(payload: Variant) -> void:
	if not payload is Dictionary: return
	tracked = tracked.filter(func(value: Dictionary) -> bool: return value.id != str(payload.get("questId", "")))
	tracked.push_back({"id": str(payload.get("questId", "")), "title": str(payload.get("title", ""))})
	_refresh_quest_hint()


func _quest_done(payload: Variant) -> void:
	if not payload is Dictionary: return
	tracked = tracked.filter(func(value: Dictionary) -> bool: return value.id != str(payload.get("questId", "")))
	_refresh_quest_hint()


func _restore(_payload: Variant = null) -> void:
	tracked.clear()
	_refresh_quest_hint()


func _rule_on(_payload: Variant = null) -> void:
	rule_hint_bg.visible = true
	rule_hint.visible = true


func _rule_off(_payload: Variant = null) -> void:
	rule_hint_bg.visible = false
	rule_hint.visible = false


func _health(payload: Variant) -> void:
	if payload is Dictionary: health_ratio = clampf(float(payload.get("current", 100)) / maxf(1, float(payload.get("max", 100))), 0, 1)


func _health_debug(payload: Variant) -> void:
	if payload is Dictionary and payload.get("enabled") == true: health_ratio = clampf(float(payload.get("ratio", payload.get("value", 1))), 0, 1)


func _smell(payload: Variant) -> void:
	if payload is Dictionary: smell.set_state(payload)


func _sniff(_payload: Variant = null) -> void:
	smell.pulse_boost()
