class_name RuntimeNotificationUI
extends RefCounted

const DISPLAY_MS := 4000
const FADE_MS := 800
const STAGGER_MS := 400
const MAX_VISIBLE := 5

var renderer: RuntimeRenderer
var event_bus: RuntimeEventBus
var list_root := Control.new()
var queue: Array[Dictionary] = []
var entries: Array[Dictionary] = []
var last_add_ms := -STAGGER_MS


func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus) -> void:
	renderer = next_renderer; event_bus = events; list_root.name = "NotificationUI"; list_root.mouse_filter = Control.MOUSE_FILTER_IGNORE; renderer.ui_layer.add_child(list_root); event_bus.on("notification:show", Callable(self, "_enqueue"))
func get_visible_count() -> int: return entries.size()
func get_queue_count() -> int: return queue.size()
func debug_flush_one() -> void: if not queue.is_empty(): _add(queue.pop_front()); last_add_ms = Time.get_ticks_msec()
func update(_dt: float) -> void:
	var now := Time.get_ticks_msec()
	if not queue.is_empty() and now - last_add_ms >= STAGGER_MS: debug_flush_one()
	for index in range(entries.size() - 1, -1, -1):
		var age := now - int(entries[index].createdAt); var node: Control = entries[index].node
		if age >= DISPLAY_MS + FADE_MS: _remove(index)
		elif age > DISPLAY_MS: node.modulate.a = 1.0 - float(age - DISPLAY_MS) / FADE_MS
func destroy() -> void:
	event_bus.off("notification:show", Callable(self, "_enqueue")); queue.clear(); entries.clear()
	if is_instance_valid(list_root): if list_root.get_parent() != null: list_root.get_parent().remove_child(list_root); list_root.free()
func _enqueue(payload: Variant) -> void:
	if payload is Dictionary: queue.push_back({"text": str(payload.get("text", "")), "type": str(payload.get("type", "info"))})
func _add(item: Dictionary) -> void:
	var entry := Control.new(); entry.size = Vector2(240, 30); entry.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var background := Panel.new(); background.size = entry.size; background.mouse_filter = Control.MOUSE_FILTER_IGNORE; var style := StyleBoxFlat.new(); style.bg_color = Color("130f0a", 0.85); style.border_color = Color("574733"); style.set_border_width_all(1); style.set_corner_radius_all(4); style.anti_aliasing = true; background.add_theme_stylebox_override("panel", style); entry.add_child(background)
	var label := Label.new(); label.text = item.text; label.position = Vector2(10, 8); label.size = Vector2(220, 20); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT; label.vertical_alignment = VERTICAL_ALIGNMENT_TOP; label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY; label.clip_text = true; label.add_theme_font_size_override("font_size", 12); label.add_theme_color_override("font_color", _color(item.type)); var font := SystemFont.new(); font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); label.add_theme_font_override("font", font); label.mouse_filter = Control.MOUSE_FILTER_IGNORE; entry.add_child(label)
	list_root.add_child(entry); renderer.ui_layer.move_child(list_root, renderer.ui_layer.get_child_count() - 1); entries.push_back({"node": entry, "createdAt": Time.get_ticks_msec()})
	if entries.size() > MAX_VISIBLE: _remove(0)
	_layout()
func _remove(index: int) -> void:
	var node: Control = entries[index].node; entries.remove_at(index); if is_instance_valid(node): node.free(); _layout()
func _layout() -> void:
	for index in entries.size(): entries[index].node.position = Vector2((renderer.get_screen_width() - 240) / 2.0, 50 + (entries.size() - 1 - index) * 34)
func _color(type: String) -> Color:
	match type:
		"quest": return Color("ffcc66")
		"rule": return Color("88ddaa")
		"item": return Color("dddddd")
		"warning": return Color("ff8866")
		"error": return Color("ff6666")
		_: return Color("aaaacc")
