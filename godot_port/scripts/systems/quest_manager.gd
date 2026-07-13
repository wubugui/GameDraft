class_name RuntimeQuestManager
extends RuntimeSystem

const QUESTS_URL := "/assets/data/quests.json"
const INACTIVE := 0
const ACTIVE := 1
const COMPLETED := 2

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor
var _quest_defs: Dictionary = {}
var _quest_order: Array[String] = []
var _quest_status: Dictionary = {}
var _evaluating := false
var _pending_evaluate := false
var _restoring := false
var _strings: RuntimeStringsProvider
var _asset_manager: RuntimeAssetManager
var _condition_context_factory := Callable()
var _action_queue: Array[Dictionary] = []
var _action_queue_running := false
var _destroyed := false


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor


func init(ctx: Dictionary) -> void:
	_strings = ctx.strings
	_asset_manager = ctx.assetManager
	_event_bus.on("flag:changed", Callable(self, "_on_state_source_changed"))
	_event_bus.on("narrative:stateChanged", Callable(self, "_on_state_source_changed"))


func update(_dt: float) -> void:
	return


func load_defs() -> bool:
	var defs: Variant = _asset_manager.load_json(QUESTS_URL)
	if not defs is Array:
		return false
	return load_defs_from_data(defs)


func load_defs_from_data(defs: Array) -> bool:
	_quest_defs.clear()
	_quest_order.clear()
	for raw: Variant in defs:
		if not raw is Dictionary:
			continue
		var id := str(raw.get("id", "")).strip_edges()
		if id.is_empty():
			continue
		var definition: Dictionary = raw.duplicate(true)
		_quest_defs[id] = definition
		_quest_order.push_back(id)
		if not _quest_status.has(id):
			_quest_status[id] = INACTIVE
	return true


func set_restoring(value: bool) -> void:
	_restoring = value


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory


func accept_quest(quest_id: String) -> void:
	var status: Variant = _quest_status.get(quest_id)
	if status != null and int(status) != INACTIVE:
		return
	_quest_status[quest_id] = ACTIVE
	_sync_flag(quest_id)
	var definition: Variant = _quest_defs.get(quest_id)
	var actions: Array = definition.get("acceptActions", []) if definition is Dictionary else []
	var title := str(definition.get("title", quest_id)) if definition is Dictionary else quest_id
	var emit_accepted := func() -> void:
		if _destroyed:
			return
		_event_bus.emit("quest:accepted", {"questId": quest_id, "title": title})
		_event_bus.emit("notification:show", {
			"text": _strings.get_text("notifications", "questAccepted", {"title": title}),
			"type": "quest",
		})
	if actions.is_empty():
		emit_accepted.call()
	else:
		_enqueue_quest_actions(actions, emit_accepted)


func get_status(quest_id: String) -> int:
	return int(_quest_status.get(quest_id, INACTIVE))


func debug_set_quest_status(quest_id: String, status: Variant) -> void:
	var id := quest_id.strip_edges()
	if id.is_empty():
		return
	_quest_status[id] = _normalize_quest_status(status)
	_sync_flag(id)


func get_quest_title(quest_id: String) -> Variant:
	var definition: Variant = _quest_defs.get(quest_id)
	return definition.get("title") if definition is Dictionary else null


func get_active_quests() -> Array:
	var result: Array = []
	for id: String in _quest_order:
		if get_status(id) == ACTIVE:
			result.push_back({"def": _quest_defs[id], "status": ACTIVE})
	return result


func get_completed_quests() -> Array:
	var result: Array = []
	for id: String in _quest_order:
		if get_status(id) == COMPLETED:
			result.push_back({"def": _quest_defs[id]})
	return result


func get_current_main_quest() -> Variant:
	for id: String in _quest_order:
		var definition: Dictionary = _quest_defs[id]
		if definition.get("type") == "main" and get_status(id) == ACTIVE:
			return definition
	return null


func serialize() -> Dictionary:
	var result := {}
	for id: String in _ordered_status_ids(): result[id] = get_status(id)
	return result


func deserialize(data: Dictionary) -> void:
	_quest_status.clear()
	for id: String in _ordered_data_ids(data):
		_quest_status[id] = int(data[id])
		_sync_flag(id)
	for id: String in _ordered_status_ids():
		if get_status(id) != ACTIVE:
			continue
		var definition: Variant = _quest_defs.get(id)
		var title := str(definition.get("title", id)) if definition is Dictionary else id
		_event_bus.emit("quest:accepted", {"questId": id, "title": title, "restored": true})


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	_event_bus.off("flag:changed", Callable(self, "_on_state_source_changed"))
	_event_bus.off("narrative:stateChanged", Callable(self, "_on_state_source_changed"))
	_quest_defs.clear()
	_quest_order.clear()
	_quest_status.clear()
	_action_queue.clear()
	_action_queue_running = false
	_condition_context_factory = Callable()


func definition_count() -> int:
	return _quest_defs.size()


func debug_snapshot_fragment() -> Dictionary:
	return {"quest": serialize()}


func _on_state_source_changed(_payload: Variant = null) -> void:
	if not _restoring:
		_evaluate()


func _eval_conditions(conditions: Array) -> bool:
	if conditions.is_empty():
		return true
	if not _condition_context_factory.is_null() and _condition_context_factory.is_valid():
		var context: Variant = _condition_context_factory.call()
		if context is Dictionary and context.get("evaluateList") is Callable:
			return bool(context.evaluateList.call(conditions))
	return _flag_store.check_conditions(conditions)


func _evaluate() -> void:
	if _evaluating:
		_pending_evaluate = true
		return
	_evaluating = true
	for id: String in _quest_order:
		var definition: Dictionary = _quest_defs[id]
		var status := get_status(id)
		var completion: Array = definition.get("completionConditions", [])
		var preconditions: Array = definition.get("preconditions", [])
		if status == ACTIVE and not completion.is_empty() and _eval_conditions(completion):
			_complete_quest(id)
		if status == INACTIVE:
			var preconditions_ok := preconditions.is_empty() or _eval_conditions(preconditions)
			if preconditions_ok and not completion.is_empty() and _eval_conditions(completion):
				_complete_quest(id)
			elif not preconditions.is_empty() and _eval_conditions(preconditions):
				accept_quest(id)
	_evaluating = false
	if _pending_evaluate:
		_pending_evaluate = false
		_evaluate()


func _ordered_data_ids(data: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for id: String in _quest_order:
		if data.has(id): result.push_back(id)
	var extras: Array[String] = []
	for raw_id: Variant in data:
		var id := str(raw_id)
		if not result.has(id): extras.push_back(id)
	extras.sort(); result.append_array(extras)
	return result


func _ordered_status_ids() -> Array[String]:
	return _ordered_data_ids(_quest_status)


func _complete_quest(quest_id: String) -> void:
	_quest_status[quest_id] = COMPLETED
	_sync_flag(quest_id)
	var definition: Variant = _quest_defs.get(quest_id)
	if not definition is Dictionary:
		return
	var finish := func() -> void:
		if _destroyed:
			return
		var title := str(definition.get("title", quest_id))
		_event_bus.emit("quest:completed", {"questId": quest_id, "title": title})
		_event_bus.emit("notification:show", {
			"text": _strings.get_text("notifications", "questCompleted", {"title": title}),
			"type": "quest",
		})
		var next_quests: Variant = definition.get("nextQuests")
		if next_quests is Array and not next_quests.is_empty():
			for raw_edge: Variant in next_quests:
				if not raw_edge is Dictionary:
					continue
				var edge: Dictionary = raw_edge
				var conditions: Array = edge.get("conditions", [])
				if not conditions.is_empty() and not _eval_conditions(conditions):
					continue
				if edge.get("bypassPreconditions", false) != true:
					var target: Variant = _quest_defs.get(str(edge.get("questId", "")))
					if target is Dictionary:
						var target_preconditions: Array = target.get("preconditions", [])
						if not target_preconditions.is_empty() and not _eval_conditions(target_preconditions):
							continue
				accept_quest(str(edge.get("questId", "")))
		elif definition.get("nextQuestId") is String:
			accept_quest(str(definition.nextQuestId))
	var rewards: Array = definition.get("rewards", [])
	if rewards.is_empty():
		finish.call()
	else:
		_enqueue_quest_actions(rewards, finish)


func _enqueue_quest_actions(actions: Array, after: Callable) -> void:
	_action_queue.push_back({"actions": actions.duplicate(true), "after": after})
	if not _action_queue_running:
		_drain_action_queue()


func _drain_action_queue() -> void:
	_action_queue_running = true
	while not _action_queue.is_empty() and not _destroyed:
		var entry: Dictionary = _action_queue.pop_front()
		await _action_executor.execute_batch_await(entry.actions)
		if not _destroyed and entry.after is Callable and entry.after.is_valid():
			entry.after.call()
	_action_queue_running = false


func _sync_flag(quest_id: String) -> void:
	_flag_store.set_value("quest_%s_status" % quest_id, get_status(quest_id))


func _normalize_quest_status(status: Variant) -> int:
	var text := str(status).strip_edges().to_lower()
	if ((status is int or status is float) and int(status) == COMPLETED) or text == "completed":
		return COMPLETED
	if ((status is int or status is float) and int(status) == ACTIVE) or text in ["active", "accepted"]:
		return ACTIVE
	return INACTIVE
