class_name RuntimeInventoryManager
extends RuntimeSystem

const MAX_SLOTS := 12
const ITEMS_URL := "/assets/data/items.json"

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _item_defs: Dictionary = {}
var _slots: Dictionary = {}
var _coins := 0.0
var _strings: RuntimeStringsProvider
var _asset_manager: RuntimeAssetManager
var _condition_context_factory := Callable()


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store


func init(ctx: Dictionary) -> void:
	_strings = ctx.strings
	_asset_manager = ctx.assetManager


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory


func update(_dt: float) -> void:
	return


func load_defs() -> bool:
	var defs: Variant = _asset_manager.load_json(ITEMS_URL)
	if not defs is Array:
		return false
	_item_defs.clear()
	for definition: Variant in defs:
		if definition is Dictionary and not str(definition.get("id", "")).is_empty():
			_item_defs[str(definition.id)] = definition
	return true


func get_item_def(id: String) -> Variant:
	return _item_defs.get(id)


func get_item_name_map() -> Dictionary:
	var result := {}
	for id: String in _item_defs:
		result[id] = str(_item_defs[id].get("name", id))
	return result


func add_item(id: String, count: int = 1, options: Dictionary = {}) -> bool:
	var existing := int(_slots.get(id, 0))
	var definition: Variant = _item_defs.get(id)
	var max_stack := int(definition.get("maxStack", 99)) if definition is Dictionary else 99
	if existing == 0 and _slots.size() >= MAX_SLOTS and options.get("bypassSlotLimit", false) != true:
		_event_bus.emit("inventory:full", {"itemId": id})
		_event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "inventoryFull"), "type": "warning"})
		return false
	var new_count := mini(existing + count, max_stack)
	_slots[id] = new_count
	_sync_item_flags(id)
	_event_bus.emit("item:acquired", {
		"itemId": id,
		"itemName": str(definition.get("name", id)) if definition is Dictionary else id,
		"count": new_count - existing,
	})
	return true


func remove_item(id: String, count: int = 1) -> bool:
	var existing := int(_slots.get(id, 0))
	if existing < count:
		return false
	var new_count := existing - count
	if new_count <= 0:
		_slots.erase(id)
	else:
		_slots[id] = new_count
	_sync_item_flags(id)
	_event_bus.emit("item:consumed", {"itemId": id, "count": count})
	return true


func has_item(id: String, count: int = 1) -> bool:
	return int(_slots.get(id, 0)) >= count


func get_item_count(id: String) -> int:
	return int(_slots.get(id, 0))


func get_all_items() -> Array:
	var result: Array = []
	for id: String in _slots:
		var entry := {"id": id, "count": int(_slots[id])}
		if _item_defs.has(id): entry["def"] = _item_defs[id]
		result.push_back(entry)
	return result


func get_coins() -> float:
	return _coins


func add_coins(amount: Variant) -> bool:
	if not (amount is int or amount is float) or not is_finite(float(amount)):
		return false
	_coins += float(amount)
	_flag_store.set_value("coins", _coins)
	_event_bus.emit("currency:changed", {"amount": float(amount), "newTotal": _coins})
	return true


func remove_coins(amount: Variant) -> bool:
	if not (amount is int or amount is float) or not is_finite(float(amount)) or _coins < float(amount):
		return false
	_coins -= float(amount)
	_flag_store.set_value("coins", _coins)
	_event_bus.emit("currency:changed", {"amount": -float(amount), "newTotal": _coins})
	return true


func get_item_description(id: String) -> String:
	var definition: Variant = _item_defs.get(id)
	if not definition is Dictionary:
		return ""
	for dynamic: Variant in definition.get("dynamicDescriptions", []):
		if not dynamic is Dictionary:
			continue
		var context: Variant = _condition_context_factory.call() if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null
		var matches := false
		if context is Dictionary and context.get("evaluateList") is Callable:
			matches = bool(context.evaluateList.call(dynamic.get("conditions", [])))
		else:
			matches = _flag_store.check_conditions(dynamic.get("conditions", []))
		if matches:
			return str(dynamic.get("text", ""))
	return str(definition.get("description", ""))


func can_discard(id: String) -> bool:
	var definition: Variant = _item_defs.get(id)
	return definition is Dictionary and definition.get("type") == "consumable"


func discard_item(id: String) -> void:
	if can_discard(id):
		_slots.erase(id)
		_sync_item_flags(id)


func serialize() -> Dictionary:
	return {"items": _slots.duplicate(true), "coins": _coins}


func deserialize(data: Dictionary) -> void:
	_slots.clear()
	var items: Variant = data.get("items", {})
	if items is Dictionary:
		for id: String in items:
			_slots[id] = int(items[id])
			_sync_item_flags(id)
	_coins = float(data.get("coins", 0.0))
	_flag_store.set_value("coins", _coins)
	_event_bus.emit("currency:changed", {"amount": 0, "newTotal": _coins, "restored": true})


func destroy() -> void:
	_slots.clear()
	_item_defs.clear()
	_coins = 0.0
	_condition_context_factory = Callable()


func debug_snapshot_fragment() -> Dictionary:
	return {"inventory": serialize()}


func definition_count() -> int:
	return _item_defs.size()


func _sync_item_flags(id: String) -> void:
	var count := int(_slots.get(id, 0))
	_flag_store.set_value("has_item_%s" % id, count > 0)
	_flag_store.set_value("item_count_%s" % id, float(count))
