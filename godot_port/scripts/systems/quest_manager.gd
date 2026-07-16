class_name RuntimeQuestManager
extends RuntimeSystem

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

const QUESTS_URL := "/assets/data/quests.json"

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var condition_ctx_factory: Variant = null

var quest_defs: Dictionary = {}
var quest_status: Dictionary = {}
var evaluating := false
var pending_evaluate := false
var strings: RuntimeStringsProvider = RuntimeStringsProvider.new()
var asset_manager: RuntimeAssetManager
var on_flag_changed: Callable
var quest_action_tail: RuntimeAsyncTail = RuntimeAsyncTail.new()
var restoring := false


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore, next_action_executor: RuntimeActionExecutor) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store
	action_executor = next_action_executor
	on_flag_changed = func(_payload: Variant = null) -> void:
		if not restoring:
			_evaluate()


func set_restoring(value: bool) -> void:
	restoring = value


func set_condition_eval_context_factory(factory: Variant = null) -> void:
	condition_ctx_factory = factory


func _eval_conditions(conditions: Array) -> bool:
	if conditions.is_empty():
		return true
	var context: Variant = condition_ctx_factory.call() if condition_ctx_factory is Callable and condition_ctx_factory.is_valid() else null
	if context:
		return RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)
	return flag_store.check_conditions(conditions)


func init(ctx: Dictionary) -> void:
	strings = ctx.strings
	asset_manager = ctx.assetManager
	event_bus.on("flag:changed", on_flag_changed)
	event_bus.on("narrative:stateChanged", on_flag_changed)


func update(_dt: float) -> void:
	return


func load_defs() -> void:
	var definitions: Variant = asset_manager.load_json(QUESTS_URL) if asset_manager != null else null
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not definitions is Array:
		push_warning("QuestManager: quests.json not found, running without quest definitions")
		return
	for definition: Variant in definitions:
		if not definition is Dictionary:
			push_warning("QuestManager: quests.json not found, running without quest definitions")
			return
		var id: Variant = definition.get("id")
		quest_defs[id] = definition
		if not quest_status.has(id):
			quest_status[id] = RuntimeDataTypes.QUEST_INACTIVE


func _enqueue_quest_actions(task: Callable) -> void:
	var tail := quest_action_tail
	RuntimeMicrotaskQueueScript.queue_microtask(func() -> void:
		await tail.then(func() -> void:
			var result: Variant = await task.call()
			if result is bool and result == false:
				push_warning("QuestManager: queued quest actions failed")
		)
	, false)


func accept_quest(quest_id: String) -> void:
	var status: Variant = quest_status.get(quest_id)
	if status != null and status != RuntimeDataTypes.QUEST_INACTIVE:
		return
	quest_status[quest_id] = RuntimeDataTypes.QUEST_ACTIVE
	_sync_flag(quest_id)
	var definition: Variant = quest_defs.get(quest_id)
	var on_accept: Variant = definition.get("acceptActions") if definition is Dictionary else null
	if on_accept == null:
		on_accept = []
	var raw_title: Variant = definition.get("title") if definition is Dictionary else null
	var title: Variant = quest_id if raw_title == null else raw_title
	var emit_accepted := func() -> void:
		event_bus.emit("quest:accepted", {"questId": quest_id, "title": title})
		event_bus.emit("notification:show", {
			"text": strings.get_text("notifications", "questAccepted", {"title": title}),
			"type": "quest",
		})
	if on_accept is Array and not on_accept.is_empty():
		_enqueue_quest_actions(func() -> void:
			var result: Variant = await action_executor.execute_batch_await(on_accept)
			if result is bool and result == false:
				push_warning("QuestManager: acceptActions failed")
			emit_accepted.call()
		)
	else:
		emit_accepted.call()


func _complete_quest(quest_id: String) -> void:
	quest_status[quest_id] = RuntimeDataTypes.QUEST_COMPLETED
	_sync_flag(quest_id)
	var definition: Variant = quest_defs.get(quest_id)
	if not definition is Dictionary:
		return
	var title: Variant = definition.get("title")
	var emit_completed_and_chain := func() -> void:
		event_bus.emit("quest:completed", {"questId": quest_id, "title": title})
		event_bus.emit("notification:show", {
			"text": strings.get_text("notifications", "questCompleted", {"title": title}),
			"type": "quest",
		})
		var next_quests: Variant = definition.get("nextQuests")
		if next_quests is Array and not next_quests.is_empty():
			for edge: Dictionary in next_quests:
				var conditions: Variant = edge.get("conditions")
				if conditions is Array and not conditions.is_empty() and not _eval_conditions(conditions):
					continue
				if not edge.get("bypassPreconditions"):
					var target_definition: Variant = quest_defs.get(edge.get("questId"))
					if target_definition is Dictionary:
						var target_preconditions: Variant = target_definition.get("preconditions")
						if target_preconditions is Array and not target_preconditions.is_empty() and not _eval_conditions(target_preconditions):
							continue
				accept_quest(str(edge.get("questId")))
		elif definition.get("nextQuestId"):
			accept_quest(str(definition.nextQuestId))
	var rewards: Variant = definition.get("rewards")
	if rewards is Array and not rewards.is_empty():
		_enqueue_quest_actions(func() -> void:
			var result: Variant = await action_executor.execute_batch_await(rewards)
			if result is bool and result == false:
				push_warning("QuestManager: rewards failed")
			emit_completed_and_chain.call()
		)
	else:
		emit_completed_and_chain.call()


func _evaluate() -> void:
	if evaluating:
		pending_evaluate = true
		return
	evaluating = true
	for raw_id: Variant in quest_defs:
		var id := str(raw_id)
		var definition: Dictionary = quest_defs[raw_id]
		var status: Variant = quest_status.get(raw_id)
		if status == null:
			status = RuntimeDataTypes.QUEST_INACTIVE
		var completion_conditions: Variant = definition.get("completionConditions")
		var preconditions: Variant = definition.get("preconditions")
		if status == RuntimeDataTypes.QUEST_ACTIVE:
			if completion_conditions is Array and not completion_conditions.is_empty() and _eval_conditions(completion_conditions):
				_complete_quest(id)
		if status == RuntimeDataTypes.QUEST_INACTIVE:
			var preconditions_ok: bool = not preconditions is Array or preconditions.is_empty() or _eval_conditions(preconditions)
			if preconditions_ok and completion_conditions is Array and not completion_conditions.is_empty() and _eval_conditions(completion_conditions):
				_complete_quest(id)
			elif preconditions is Array and not preconditions.is_empty() and _eval_conditions(preconditions):
				accept_quest(id)
	evaluating = false
	if pending_evaluate:
		pending_evaluate = false
		_evaluate()


func get_status(quest_id: String) -> Variant:
	var status: Variant = quest_status.get(quest_id)
	return RuntimeDataTypes.QUEST_INACTIVE if status == null else status


func debug_set_quest_status(quest_id: String, status: Variant) -> void:
	var id := quest_id.strip_edges()
	if id.is_empty():
		return
	var normalized := _normalize_quest_status(status)
	quest_status[id] = normalized
	_sync_flag(id)


func get_quest_title(quest_id: String) -> Variant:
	var definition: Variant = quest_defs.get(quest_id)
	return definition.get("title") if definition is Dictionary else null


func get_active_quests() -> Array:
	var result: Array = []
	for raw_id: Variant in quest_defs:
		var id := str(raw_id)
		var status: Variant = quest_status.get(raw_id)
		if status == RuntimeDataTypes.QUEST_ACTIVE:
			result.push_back({"def": quest_defs[raw_id], "status": status})
	return result


func get_completed_quests() -> Array:
	var result: Array = []
	for raw_id: Variant in quest_defs:
		if quest_status.get(raw_id) == RuntimeDataTypes.QUEST_COMPLETED:
			result.push_back({"def": quest_defs[raw_id]})
	return result


func get_current_main_quest() -> Variant:
	for raw_id: Variant in quest_defs:
		var definition: Dictionary = quest_defs[raw_id]
		if definition.get("type") == "main" and quest_status.get(raw_id) == RuntimeDataTypes.QUEST_ACTIVE:
			return definition
	return null


func _sync_flag(quest_id: String) -> void:
	flag_store.set_value("quest_%s_status" % quest_id, get_status(quest_id))


func _normalize_quest_status(status: Variant) -> int:
	var untrimmed_text := str(status).to_lower()
	if ((status is int or status is float) and float(status) == float(RuntimeDataTypes.QUEST_COMPLETED)) or untrimmed_text == "completed":
		return RuntimeDataTypes.QUEST_COMPLETED
	var text := str(status).strip_edges().to_lower()
	if ((status is int or status is float) and float(status) == float(RuntimeDataTypes.QUEST_ACTIVE)) or text == "active" or text == "accepted":
		return RuntimeDataTypes.QUEST_ACTIVE
	return RuntimeDataTypes.QUEST_INACTIVE


func serialize() -> Dictionary:
	var data := {}
	for id: Variant in quest_status:
		data[id] = quest_status[id]
	return data


func deserialize(data: Dictionary) -> void:
	quest_status.clear()
	for raw_id: Variant in data:
		var id := str(raw_id)
		quest_status[id] = data[raw_id]
		_sync_flag(id)
	for raw_id: Variant in quest_status:
		var status: Variant = quest_status[raw_id]
		if not (status is int or status is float) or float(status) != float(RuntimeDataTypes.QUEST_ACTIVE):
			continue
		var id := str(raw_id)
		var definition: Variant = quest_defs.get(id)
		var raw_title: Variant = definition.get("title") if definition is Dictionary else null
		var title: Variant = id if raw_title == null else raw_title
		event_bus.emit("quest:accepted", {"questId": id, "title": title, "restored": true})


func destroy() -> void:
	event_bus.off("flag:changed", on_flag_changed)
	event_bus.off("narrative:stateChanged", on_flag_changed)
	quest_defs.clear()
	quest_status.clear()
	quest_action_tail = RuntimeAsyncTail.new()
