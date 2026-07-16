class_name RuntimeWorldFilterPipeline
extends RefCounted

var target: CanvasGroup
var filters: Array = []

# Pixi executes Container.filters as an ordered render-texture chain. Godot has
# one Material slot per CanvasItem, so the engine boundary represents every
# additional pass as an enclosing CanvasGroup. The translated state and public
# methods below retain WorldFilterPipeline.ts semantics; only this private
# adapter owns the different rendering primitive.
var _pass_groups: Array[CanvasGroup] = []


func _init(next_target: CanvasGroup) -> void:
	target = next_target


func set_filters(next_filters: Array) -> void:
	filters = next_filters
	_apply()


func push_filter(filter: Material) -> void:
	filters = filters + [filter]
	_apply()


func pop_filter() -> Variant:
	var removed: Variant = filters.pop_back() if not filters.is_empty() else null
	_apply()
	return removed


func clear() -> void:
	filters = []
	_apply()


func get_filters() -> Array:
	return filters


func has_filters() -> bool:
	return not filters.is_empty()


func _apply() -> void:
	_unwrap_target()
	if target == null:
		return
	target.material = filters[0] if not filters.is_empty() else null
	if filters.size() < 2:
		return
	var host_parent: Node = target.get_parent()
	if host_parent == null:
		if not target.tree_entered.is_connected(_apply):
			target.tree_entered.connect(_apply, CONNECT_ONE_SHOT)
		return
	var host_index: int = target.get_index()
	host_parent.remove_child(target)
	var current: CanvasItem = target
	for index in range(1, filters.size()):
		var pass_group := CanvasGroup.new()
		pass_group.name = "WorldFilterPass:%d" % index
		pass_group.material = filters[index]
		pass_group.add_child(current)
		_pass_groups.push_back(pass_group)
		current = pass_group
	host_parent.add_child(current)
	host_parent.move_child(current, mini(host_index, host_parent.get_child_count() - 1))


func _unwrap_target() -> void:
	if _pass_groups.is_empty() or target == null:
		return
	var outermost: CanvasGroup = _pass_groups.back()
	var host_parent: Node = outermost.get_parent()
	if host_parent == null:
		_pass_groups.clear()
		return
	var host_index: int = outermost.get_index()
	var target_parent: Node = target.get_parent()
	if target_parent != null:
		target_parent.remove_child(target)
	host_parent.remove_child(outermost)
	outermost.free()
	_pass_groups.clear()
	host_parent.add_child(target)
	host_parent.move_child(target, mini(host_index, host_parent.get_child_count() - 1))
