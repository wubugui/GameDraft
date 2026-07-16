class_name RuntimePickupNotification
extends RefCounted

const MAX_VISIBLE := 5
var renderer: RuntimeRenderer
var strings: RuntimeStringsProvider
var active: Array[Label] = []


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider) -> void: renderer = next_renderer; strings = next_strings
func get_visible_count() -> int: return active.size()
func show(item_name: String, count: int) -> void:
	var label := Label.new(); label.text = strings.get_text("pickup", "acquired", {"name": item_name, "count": count}); label.size = Vector2(270, 34); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; var style := StyleBoxFlat.new(); style.bg_color = Color(0, 0, 0, 0.75); style.set_corner_radius_all(5); label.add_theme_stylebox_override("normal", style); renderer.ui_layer.add_child(label); active.push_back(label)
	if active.size() > MAX_VISIBLE: _remove(active[0])
	_layout(); _expire(label)
func force_cleanup() -> void:
	for label: Label in active: if is_instance_valid(label): label.free()
	active.clear()
func destroy() -> void: force_cleanup()
func _expire(label: Label) -> void:
	await Engine.get_main_loop().create_timer(1.5).timeout
	if not active.has(label) or not is_instance_valid(label): return
	var tween := label.create_tween(); tween.tween_property(label, "modulate:a", 0.0, 0.5); await tween.finished; _remove(label)
func _remove(label: Label) -> void:
	active.erase(label); if is_instance_valid(label): label.free(); _layout()
func _layout() -> void:
	for index in active.size(): active[index].position = Vector2(renderer.screen_width - 290, 20 + index * 40)
