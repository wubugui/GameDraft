class_name RuntimeInventoryManager
extends RuntimeSystem

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

const MAX_SLOTS := 12
const ITEMS_URL := "/assets/data/items.json"

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore

var item_defs: Dictionary = {}
var slots: Dictionary = {}
var coins := 0.0
var loaded := false
var strings: RuntimeStringsProvider = RuntimeStringsProvider.new()
var asset_manager: RuntimeAssetManager
var condition_ctx_factory: Variant = null


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store


func init(ctx: Dictionary) -> void:
	strings = ctx.strings
	asset_manager = ctx.assetManager


func set_condition_eval_context_factory(factory: Variant = null) -> void:
	condition_ctx_factory = factory


func update(_dt: float) -> void:
	return


func load_defs() -> void:
	var definitions: Variant = asset_manager.load_json(ITEMS_URL) if asset_manager != null else null
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not definitions is Array:
		push_warning("InventoryManager: items.json not found, running without item definitions")
		loaded = true
		return
	for definition: Variant in definitions:
		# Accessing def.id would reject the source Promise for a non-object. The
		# local asset adapter has no exception channel, so stop at the same entry
		# and take the source catch branch without rolling back prior Map.set calls.
		if not definition is Dictionary:
			push_warning("InventoryManager: items.json not found, running without item definitions")
			loaded = true
			return
		item_defs[definition.get("id")] = definition
	loaded = true


func get_item_def(id: String) -> Variant:
	return item_defs.get(id)


func _get_used_slots() -> int:
	return slots.size()


func add_item(id: String, count: float = 1.0, options: Variant = null) -> bool:
	var existing := float(slots.get(id, 0.0))
	var definition: Variant = item_defs.get(id)
	var raw_max_stack: Variant = definition.get("maxStack") if definition is Dictionary else null
	var max_stack := 99.0 if raw_max_stack == null else float(raw_max_stack)
	var bypass_slot_limit := false
	if options is Dictionary:
		var bypass_raw: Variant = options.get("bypassSlotLimit")
		bypass_slot_limit = bypass_raw is bool and bypass_raw

	if existing == 0.0 and _get_used_slots() >= MAX_SLOTS and not bypass_slot_limit:
		event_bus.emit("inventory:full", {"itemId": id})
		event_bus.emit("notification:show", {"text": strings.get_text("notifications", "inventoryFull"), "type": "warning"})
		return false

	var new_count := minf(existing + count, max_stack)
	slots[id] = new_count
	_sync_item_flags(id)
	var raw_name: Variant = definition.get("name") if definition is Dictionary else null
	event_bus.emit("item:acquired", {
		"itemId": id,
		"itemName": id if raw_name == null else raw_name,
		"count": new_count - existing,
	})
	return true


func remove_item(id: String, count: float = 1.0) -> bool:
	var existing := float(slots.get(id, 0.0))
	if existing < count:
		return false

	var new_count := existing - count
	if new_count <= 0.0:
		slots.erase(id)
	else:
		slots[id] = new_count
	_sync_item_flags(id)
	event_bus.emit("item:consumed", {"itemId": id, "count": count})
	return true


func has_item(id: String, count: float = 1.0) -> bool:
	return float(slots.get(id, 0.0)) >= count


func get_item_count(id: String) -> float:
	return float(slots.get(id, 0.0))


func get_all_items() -> Array:
	var result: Array = []
	for raw_id: Variant in slots:
		var id := str(raw_id)
		result.push_back({"id": id, "count": slots[raw_id], "def": item_defs.get(id)})
	return result


func get_coins() -> float:
	return coins


func add_coins(amount: Variant) -> void:
	if not (amount is int or amount is float) or not is_finite(float(amount)):
		push_warning("InventoryManager.addCoins: 非法金额 %s，已拒绝" % str(amount))
		return
	coins += float(amount)
	flag_store.set_value("coins", coins)
	event_bus.emit("currency:changed", {"amount": amount, "newTotal": coins})


func remove_coins(amount: Variant) -> bool:
	if not (amount is int or amount is float) or not is_finite(float(amount)):
		push_warning("InventoryManager.removeCoins: 非法金额 %s，已拒绝" % str(amount))
		return false
	if coins < float(amount):
		return false
	coins -= float(amount)
	flag_store.set_value("coins", coins)
	event_bus.emit("currency:changed", {"amount": -float(amount), "newTotal": coins})
	return true


func get_item_description(id: String) -> String:
	var definition: Variant = item_defs.get(id)
	if not definition is Dictionary:
		return ""

	var dynamic_descriptions: Variant = definition.get("dynamicDescriptions")
	if dynamic_descriptions:
		for dynamic: Variant in dynamic_descriptions:
			if not dynamic is Dictionary:
				continue
			var context: Variant = condition_ctx_factory.call() if condition_ctx_factory is Callable and condition_ctx_factory.is_valid() else null
			var matches := RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(dynamic.get("conditions"), context) \
				if context is Dictionary else flag_store.check_conditions(dynamic.get("conditions", []))
			if matches:
				return str(dynamic.get("text"))
	return str(definition.get("description"))


func can_discard(id: String) -> bool:
	var definition: Variant = item_defs.get(id)
	return definition is Dictionary and definition.get("type") == "consumable"


func discard_item(id: String) -> void:
	if not can_discard(id):
		return
	slots.erase(id)
	_sync_item_flags(id)


func _sync_item_flags(id: String) -> void:
	var count := float(slots.get(id, 0.0))
	flag_store.set_value("has_item_%s" % id, count > 0.0)
	flag_store.set_value("item_count_%s" % id, count)


func serialize() -> Dictionary:
	var items := {}
	for raw_id: Variant in slots:
		items[raw_id] = slots[raw_id]
	return {"items": items, "coins": coins}


func deserialize(data: Dictionary) -> void:
	slots.clear()
	var items: Variant = data.get("items")
	if not items is Dictionary:
		return
	for raw_id: Variant in items:
		var id := str(raw_id)
		slots[id] = items[raw_id]
		_sync_item_flags(id)
	var raw_coins: Variant = data.get("coins")
	coins = 0.0 if raw_coins == null else float(raw_coins)
	flag_store.set_value("coins", coins)
	event_bus.emit("currency:changed", {"amount": 0, "newTotal": coins, "restored": true})


func destroy() -> void:
	slots.clear()
	item_defs.clear()
	coins = 0.0
