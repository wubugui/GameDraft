class_name RuntimeActionRegistry
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

# Direct, file-level translation of src/core/ActionRegistry.ts.
# This script intentionally has no instance state and no domain registration groups:
# the TypeScript module exports functions, so the Godot module does the same.

const RuntimeActionParamManifestScript := preload("res://scripts/runtime/action_param_manifest.gd")


static func _parse_scripted_portrait_ref(raw: Variant) -> Variant:
	if not raw is Dictionary:
		return null
	var emotion := str(raw.get("emotion", "")).strip_edges()
	if emotion.is_empty():
		return null
	var slug := str(raw.get("slug", "")).strip_edges()
	return {"slug": slug, "emotion": emotion} if not slug.is_empty() else {"emotion": emotion}


static func _resolve_currency_amount_param(raw: Variant, resolve_display_text: Callable, label: String) -> Variant:
	var source := "" if raw == null else str(raw)
	var resolved := str(resolve_display_text.call(source)).strip_edges()
	if resolved.is_empty():
		push_warning("%s: 金额为空，已跳过" % label)
		return null
	var number: Variant = _js_number(resolved)
	if number == null:
		push_warning("%s: 无法将解析结果当作数字: %s" % [label, JSON.stringify(resolved)])
		return null
	var amount := int(float(number))
	if amount < 0:
		push_warning("%s: 金额为负 (%s)，已跳过" % [label, amount])
		return null
	return amount


static func _parse_loose_boolean_param(raw: Variant) -> Variant:
	if raw == null:
		return null
	if raw is bool:
		return raw
	if raw is int or raw is float:
		return float(raw) != 0.0
	var value := str(raw).strip_edges().to_lower()
	if value in ["true", "1"]:
		return true
	if value in ["false", "0"]:
		return false
	return null


static func _parse_duration_ms_param(params: Dictionary, fallback: float) -> float:
	var raw: Variant = params.get("durationMs")
	if raw == null:
		raw = params.get("duration")
	if raw == null:
		raw = fallback
	var number: Variant = _js_number(raw)
	return float(number) if number != null and float(number) >= 0.0 else fallback


static func _parse_bubble_duration_param(params: Dictionary, fallback: float = 1500.0) -> float:
	var raw: Variant = params.get("duration", fallback)
	var number: Variant = _js_number(raw)
	return float(number) if number != null and float(number) > 0.0 else fallback


static func _parse_emote_offset_params(params: Dictionary) -> Dictionary:
	var ox: Variant = _js_number(params.get("anchorOffsetX"))
	var oy: Variant = _js_number(params.get("anchorOffsetY"))
	return {
		"anchorOffsetX": float(ox) if ox != null else 0.0,
		"anchorOffsetY": float(oy) if oy != null else 0.0,
	}


static func _parse_move_entity_waypoint_list(raw: Variant) -> Array:
	if not raw is Array:
		return []
	var output: Array = []
	for item: Variant in raw:
		if not item is Dictionary:
			continue
		var x: Variant = _js_number_param(item, "x")
		var y: Variant = _js_number_param(item, "y")
		if x != null and y != null:
			output.push_back({"x": float(x), "y": float(y)})
	return output


static func _parse_face_toward_movement_param(raw: Variant) -> bool:
	if raw == true:
		return true
	if raw == false or raw == null:
		return false
	if raw is int or raw is float:
		return float(raw) != 0.0
	return str(raw).strip_edges().to_lower() in ["true", "1", "yes"]


static func _speech_bubble_raw_text(params: Dictionary) -> String:
	var text := _nullish_string(params.get("text")).strip_edges()
	return text if not text.is_empty() else _nullish_string(params.get("emote")).strip_edges()


static func _is_param_object(value: Variant) -> bool:
	return value is Dictionary


static func _action_list_from_param(raw: Variant) -> Array:
	if not raw is Array:
		return []
	var output: Array = []
	for item: Variant in raw:
		if not _is_param_object(item) or not item.get("type") is String:
			continue
		output.push_back({
			"type": item.type,
			"params": item.params if item.get("params") is Dictionary else {},
		})
	return output


static func _dbg(deps: Dictionary, tag: String, line: String) -> void:
	var callback: Variant = deps.get("debugPanelLog")
	if callback is Callable and callback.is_valid():
		callback.call("[%s] %s" % [tag, line])


static func register_action_handlers(executor: RuntimeActionExecutor, d: Dictionary) -> void:
	executor.register("enableRuleOffers", func(p: Dictionary, zctx: Variant) -> void:
		if not zctx is Dictionary or _nullish_string(zctx.get("zoneId")).is_empty():
			push_warning("enableRuleOffers: missing zone context (must run from ZoneSystem batch)")
			return
		var slots: Variant = p.get("slots")
		if not slots is Array:
			return
		d.ruleOfferRegistry.register(str(zctx.zoneId), slots)
	, ["slots"])

	executor.register("disableRuleOffers", func(_p: Dictionary, zctx: Variant) -> void:
		if not zctx is Dictionary or _nullish_string(zctx.get("zoneId")).is_empty():
			push_warning("disableRuleOffers: missing zone context (must run from ZoneSystem batch)")
			return
		d.ruleOfferRegistry.unregister(str(zctx.zoneId))
	, [])

	executor.register("runActions", func(p: Dictionary, zctx: Variant) -> void:
		await executor.execute_batch_await(_action_list_from_param(p.get("actions")), zctx)
	, ["actions"])

	executor.register("chooseAction", func(p: Dictionary, zctx: Variant) -> void:
		var options: Array = []
		var raw_options: Variant = p.get("options")
		if raw_options is Array:
			for item: Variant in raw_options:
				if not _is_param_object(item):
					continue
				var text := str(d.resolveDisplayText.call(_nullish_string(item.get("text")))).strip_edges()
				if not text.is_empty():
					options.push_back({"text": text, "actions": _action_list_from_param(item.get("actions"))})
		if options.is_empty():
			push_warning("chooseAction: options 为空")
			return
		var previous: String = d.stateController.current_state
		d.stateController.set_state(RuntimeDataTypes.UI_OVERLAY)
		var option_labels: Array = options.map(func(item: Dictionary) -> Dictionary: return {"text": item.text})
		var picked: Variant = await d.chooseAction.call(
			str(d.resolveDisplayText.call(_nullish_string(p.get("prompt")))),
			option_labels,
			p.get("allowCancel") == true
		)
		if d.stateController.current_state == RuntimeDataTypes.UI_OVERLAY:
			d.stateController.set_state(previous)
		if picked == null or not picked is int or picked < 0 or picked >= options.size():
			return
		await executor.execute_batch_await(options[picked].actions, zctx)
	, ["prompt", "options", "allowCancel"])

	executor.register("randomBranch", func(p: Dictionary, zctx: Variant) -> void:
		var threshold: Variant = _js_number_param(p, "probability")
		if threshold == null:
			threshold = 0.5
		threshold = clampf(float(threshold), 0.0, 1.0)
		var sample := float(d.randomValue.call())
		var key := "aboveActions" if sample > threshold else "belowActions"
		await executor.execute_batch_await(_action_list_from_param(p.get(key)), zctx)
	, ["probability", "aboveActions", "belowActions"])

	executor.register("setScenarioPhase", func(p: Dictionary, _zctx: Variant) -> Variant:
		var scenario_id := _nullish_string(p.get("scenarioId")).strip_edges()
		var phase := _nullish_string(p.get("phase")).strip_edges()
		var status := _nullish_string(p.get("status")).strip_edges()
		if scenario_id.is_empty() or phase.is_empty() or status.is_empty():
			return null
		var phase_state := {"status": status}
		if p.has("outcome") and p.outcome != null:
			phase_state.outcome = p.outcome
		return d.scenarioStateManager.set_scenario_phase(scenario_id, phase, phase_state)
	, ["scenarioId", "phase", "status"])

	executor.register("startScenario", func(p: Dictionary, _zctx: Variant) -> Variant:
		var scenario_id := _nullish_string(p.get("scenarioId")).strip_edges()
		return null if scenario_id.is_empty() else d.scenarioStateManager.assert_scenario_line_entry_for_action(scenario_id)
	, ["scenarioId"])

	executor.register("activateScenario", func(p: Dictionary, _zctx: Variant) -> Variant:
		var scenario_id := _nullish_string(p.get("scenarioId")).strip_edges()
		return null if scenario_id.is_empty() else d.scenarioStateManager.activate_scenario_line(scenario_id)
	, ["scenarioId"])

	executor.register("completeScenario", func(p: Dictionary, _zctx: Variant) -> Variant:
		var scenario_id := _nullish_string(p.get("scenarioId")).strip_edges()
		return null if scenario_id.is_empty() else d.scenarioStateManager.complete_scenario_line(scenario_id)
	, ["scenarioId"])

	executor.register("emitNarrativeSignal", func(p: Dictionary, _zctx: Variant) -> void:
		var event_signal := _nullish_string(p.get("signal")).strip_edges()
		if event_signal.is_empty():
			push_warning("emitNarrativeSignal: missing signal (event id) %s" % [p])
			return
		var payload := {"signal": event_signal}
		var source_type := _nullish_string(p.get("sourceType")).strip_edges()
		var source_id := _nullish_string(p.get("sourceId")).strip_edges()
		if not source_type.is_empty() and not source_id.is_empty():
			payload.sourceType = source_type
			payload.sourceId = source_id
		await d.narrativeStateManager.emit_narrative_signal(payload)
	, ["signal"])

	executor.register("giveItem", func(p: Dictionary, _zctx: Variant) -> void:
		var options := {"bypassSlotLimit": true} if p.get("critical") == true else {}
		var ok: bool = d.inventoryManager.add_item(p.get("id"), _nullish_param(p, "count", 1), options)
		if not ok:
			push_warning("giveItem: 背包已满，物品 \"%s\" 未能给予（非 critical 给予不绕过槽上限）" % _nullish_string(p.get("id")))
	, ["id", "count", "critical"])

	executor.register("removeItem", func(p: Dictionary, _zctx: Variant) -> void:
		d.inventoryManager.remove_item(p.get("id"), _nullish_param(p, "count", 1))
	, ["id", "count"])

	executor.register("giveCurrency", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _resolve_currency_amount_param(p.get("amount"), d.resolveDisplayText, "giveCurrency")
		if amount != null:
			d.inventoryManager.add_coins(amount)
	, ["amount"])

	executor.register("removeCurrency", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _resolve_currency_amount_param(p.get("amount"), d.resolveDisplayText, "removeCurrency")
		if amount != null:
			d.inventoryManager.remove_coins(amount)
	, ["amount"])

	executor.register("giveRule", func(p: Dictionary, _zctx: Variant) -> void:
		d.rulesManager.give_rule(p.get("id"))
	, ["id"])

	executor.register("grantRuleLayer", func(p: Dictionary, _zctx: Variant) -> void:
		var rule_id := _nullish_string(p.get("ruleId")).strip_edges()
		var layer := _nullish_string(p.get("layer")).strip_edges()
		if rule_id.is_empty() or layer not in ["xiang", "li", "shu"]:
			push_warning("grantRuleLayer: 需要 params.ruleId 与 params.layer（xiang|li|shu）")
			return
		d.rulesManager.grant_layer(rule_id, layer)
	, ["ruleId", "layer"])

	executor.register("giveFragment", func(p: Dictionary, _zctx: Variant) -> void:
		d.rulesManager.give_fragment(p.get("id"))
	, ["id"])

	executor.register("updateQuest", func(p: Dictionary, _zctx: Variant) -> void:
		d.questManager.accept_quest(p.get("id"))
	, ["id"])

	executor.register("startEncounter", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty() or not d.encounterManager.has_encounter(id):
			push_warning("startEncounter: 未知遭遇 id \"%s\"，不切换状态" % id)
			return
		d.stateController.set_state(RuntimeDataTypes.ENCOUNTER)
		d.encounterManager.start_encounter(id)
	, ["id"])

	executor.register("playBgm", func(p: Dictionary, _zctx: Variant) -> void:
		d.audioManager.play_bgm(p.get("id"), _nullish_param(p, "fadeMs", 1000))
	, ["id", "fadeMs"])

	executor.register("stopBgm", func(p: Dictionary, _zctx: Variant) -> void:
		d.audioManager.stop_bgm(_nullish_param(p, "fadeMs", 1000))
	, ["fadeMs"])

	executor.register("playSfx", func(p: Dictionary, _zctx: Variant) -> void:
		var volume: Variant = _js_number_param(p, "volume")
		d.audioManager.play_sfx(p.get("id"), volume)
	, ["id", "volume"])

	executor.register("stopSceneAmbient", func(p: Dictionary, _zctx: Variant) -> void:
		var fade_ms: Variant = _nullish_param(p, "fadeMs", 500)
		if p.get("id"):
			d.audioManager.remove_ambient(p.id, fade_ms)
		else:
			d.audioManager.clear_ambient(fade_ms)
	, ["id", "fadeMs"])

	executor.register("endDay", func(_p: Dictionary, _zctx: Variant) -> void:
		await d.dayManager.end_day()
	, [])

	executor.register("addDelayedEvent", func(p: Dictionary, _zctx: Variant) -> void:
		var raw: Variant = p.get("actions")
		var actions: Array = []
		if raw is Array:
			for action: Variant in raw:
				if action is Dictionary and action.get("type") is String:
					actions.push_back(action)
		if raw is Array and not raw.is_empty() and actions.size() != raw.size():
			push_warning("addDelayedEvent: 已跳过无效的嵌套动作项")
		d.dayManager.add_delayed_event(p.get("targetDay"), actions)
	, ["targetDay", "actions"])

	executor.register("addArchiveEntry", func(p: Dictionary, _zctx: Variant) -> void:
		d.archiveManager.add_entry(p.get("bookType"), p.get("entryId"))
	, ["bookType", "entryId"])

	executor.register("startCutscene", func(p: Dictionary, _zctx: Variant) -> void:
		var previous: String = d.stateController.current_state
		d.stateController.set_state(RuntimeDataTypes.CUTSCENE)
		var ok: Variant = await d.cutsceneManager.start_cutscene(p.get("id"))
		if ok == false:
			push_warning("ActionRegistry: startCutscene failed")
		if d.stateController.current_state == RuntimeDataTypes.CUTSCENE:
			d.stateController.set_state(previous)
	, ["id"])

	executor.register("startWaterMinigame", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("startWaterMinigame: 需要 params.id")
			return
		await d.waterMinigameManager.run_until_done(id)
	, ["id"])

	executor.register("startPressureHold", func(p: Dictionary, _zctx: Variant) -> Variant:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("startPressureHold: 需要 params.id")
			return
		var result: Variant = await d.pressureHoldManager.run_until_done(id)
		if result is bool and result == false:
			return false
		return
	, ["id"])

	executor.register("playSignalCue", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("playSignalCue: 需要 params.id")
			return
		await d.signalCueManager.play(id)
	, ["id"])

	executor.register("damagePlayer", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _js_number(p.get("amount", 0))
		if amount == null or float(amount) <= 0.0:
			return
		await d.healthSystem.damage(float(amount))
	, ["amount"])

	executor.register("healPlayer", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _js_number(p.get("amount", 0))
		if amount == null or float(amount) <= 0.0:
			return
		d.healthSystem.heal(float(amount))
	, ["amount"])

	executor.register("resetHealth", func(_p: Dictionary, _zctx: Variant) -> void:
		d.healthSystem.set_health(d.healthSystem.get_max_health())
	, [])

	executor.register("setHealth", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _js_number_param(p, "amount")
		if amount != null:
			d.healthSystem.set_health(float(amount))
	, ["amount"])

	executor.register("incHealth", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _js_number(p.get("amount", 0))
		if amount != null:
			d.healthSystem.set_health(d.healthSystem.get_health() + float(amount))
	, ["amount"])

	executor.register("decHealth", func(p: Dictionary, _zctx: Variant) -> void:
		var amount: Variant = _js_number(p.get("amount", 0))
		if amount != null:
			d.healthSystem.set_health(d.healthSystem.get_health() - float(amount))
	, ["amount"])

	executor.register("triggerDeathTether", func(_p: Dictionary, _zctx: Variant) -> void:
		await d.healthSystem.tether()
	, [])

	executor.register("setSmell", func(p: Dictionary, _zctx: Variant) -> void:
		var intensity: Variant = _js_number(p.intensity) if p.has("intensity") else null
		var direction: Variant = _js_number(p.dir) if p.has("dir") else null
		var flicker: Variant = _js_boolean(p.flicker) if p.has("flicker") else null
		d.smellSystem.set_smell(_nullish_string(p.get("scent")), intensity, direction, flicker)
	, ["scent", "intensity", "dir", "flicker"])

	executor.register("clearSmell", func(_p: Dictionary, _zctx: Variant) -> void:
		d.smellSystem.clear_smell()
	, [])

	executor.register("sniff", func(_p: Dictionary, _zctx: Variant) -> void:
		d.smellSystem.sniff()
	, [])

	executor.register("activatePlane", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("activatePlane: missing id (plane id) %s" % [p])
			return
		d.planeReconciler.activate_plane_manually(id)
	, ["id"])

	executor.register("deactivatePlane", func(_p: Dictionary, _zctx: Variant) -> void:
		d.planeReconciler.deactivate_manual_plane()
	, [])

	executor.register("startSugarWheelMinigame", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			var callback: Variant = d.get("debugPanelLog")
			if callback is Callable and callback.is_valid():
				callback.call("[糖画转盘] startSugarWheelMinigame: 需要 params.id")
			return
		await d.sugarWheelMinigameManager.run_until_done(id)
	, ["id"])

	executor.register("startPaperCraftMinigame", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			var callback: Variant = d.get("debugPanelLog")
			if callback is Callable and callback.is_valid():
				callback.call("[扎纸小游戏] startPaperCraftMinigame: 需要 params.id")
			return
		await d.paperCraftMinigameManager.run_until_done(id)
	, ["id"])

	executor.register("sugarWheelShowSpeech", func(p: Dictionary, _zctx: Variant) -> void:
		var role := _nullish_string(p.get("role")).strip_edges()
		var text := _nullish_string(p.get("text")).strip_edges()
		if role.is_empty() or text.is_empty():
			var callback: Variant = d.get("debugPanelLog")
			if callback is Callable and callback.is_valid():
				callback.call("[糖画转盘] sugarWheelShowSpeech: 需要 role 与 text")
			return
		var duration_ms: Variant = p.get("durationMs")
		if not (duration_ms is int or duration_ms is float) or not is_finite(float(duration_ms)):
			duration_ms = null
		d.sugarWheelMinigameManager.show_speech(role, text, duration_ms)
	, ["role", "text"])

	executor.register("sugarWheelDismissSpeech", func(p: Dictionary, _zctx: Variant) -> void:
		var role := _nullish_string(p.get("role")).strip_edges()
		if role.is_empty():
			var callback: Variant = d.get("debugPanelLog")
			if callback is Callable and callback.is_valid():
				callback.call("[糖画转盘] sugarWheelDismissSpeech: 需要 role")
			return
		d.sugarWheelMinigameManager.dismiss_speech(role)
	, ["role"])

	executor.register("sugarWheelDismissAllSpeech", func(_p: Dictionary, _zctx: Variant) -> void:
		d.sugarWheelMinigameManager.dismiss_all_speech()
	, [])

	executor.register("sugarWheelResetPointer", func(p: Dictionary, _zctx: Variant) -> void:
		var raw: Variant = p.get("angleDeg")
		if raw == null:
			raw = p.get("angle")
		var degrees: Variant = _js_number(raw)
		if degrees == null:
			var callback: Variant = d.get("debugPanelLog")
			if callback is Callable and callback.is_valid():
				callback.call("[糖画转盘] sugarWheelResetPointer: params.angleDeg 须为数值（度）")
			return
		d.sugarWheelMinigameManager.reset_pointer_geom_angle_deg(float(degrees))
	, ["angleDeg"])

	executor.register("debugAlertActionParams", func(p: Dictionary, _zctx: Variant) -> void:
		var title := _nullish_string(p.get("title")).strip_edges()
		var body := (title + "\n\n" if not title.is_empty() else "") + JSON.stringify(p, "  ")
		if DisplayServer.get_name() == "headless":
			push_warning("debugAlertActionParams (no alert): %s" % [p])
		else:
			OS.alert(body, "Action Params")
	, [])

	executor.register("showEmote", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var emote := _nullish_string(p.get("emote")).strip_edges()
		var scene_id: String = d.sceneManager.get_current_scene_id()
		_dbg(d, "showEmote", "开始 scene=%s target=%s emote=%s" % [scene_id if not scene_id.is_empty() else "(?)", JSON.stringify(target), JSON.stringify(emote)])
		if target.is_empty() or emote.is_empty():
			_dbg(d, "showEmote", "中止：缺少 target 或 emote")
			push_warning("showEmote: 需要 target 与 emote")
			return
		var subject: Variant = d.resolveEmoteTarget.call(target)
		var kind := _emote_target_debug_kind(subject)
		_dbg(d, "showEmote", "resolve 结果: %s" % kind)
		if subject == null:
			_dbg(d, "showEmote", "中止：resolveEmoteTarget 返回 null")
			push_warning("showEmote: 找不到 NPC / player / 过场实体 / 当前场景热点 \"%s\"" % target)
			return
		var duration := _parse_bubble_duration_param(p)
		var offset := _parse_emote_offset_params(p)
		_dbg(d, "showEmote", "调用 bubble.show durMs=%s off=(%s,%s)" % [duration, offset.anchorOffsetX, offset.anchorOffsetY])
		d.emoteBubbleManager.show(subject, emote, duration, offset)
		_dbg(d, "showEmote", "bubble.show 已返回")
	, ["target", "emote", "duration", "anchorOffsetX", "anchorOffsetY"])

	executor.register("showSpeechBubble", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var raw := _speech_bubble_raw_text(p)
		var scene_id: String = d.sceneManager.get_current_scene_id()
		_dbg(d, "showSpeechBubble", "scene=%s target=%s rawLen=%s" % [scene_id if not scene_id.is_empty() else "(?)", JSON.stringify(target), raw.length()])
		if target.is_empty() or raw.is_empty():
			push_warning("showSpeechBubble: 需要 target 与 text")
			return
		var text := str(d.resolveDisplayText.call(raw)).strip_edges()
		if text.is_empty():
			push_warning("showSpeechBubble: 解析后文案为空")
			return
		var subject: Variant = d.resolveEmoteTarget.call(target)
		if subject == null:
			push_warning("showSpeechBubble: 找不到 NPC / player / 过场实体 / 当前场景热点 \"%s\"" % target)
			return
		d.emoteBubbleManager.show(subject, text, _parse_bubble_duration_param(p), _parse_emote_offset_params(p))
	, ["target", "text", "duration", "anchorOffsetX", "anchorOffsetY"])

	executor.register("playNpcAnimation", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var state := _nullish_string(p.get("state")).strip_edges()
		if target.is_empty() or state.is_empty():
			push_warning("playNpcAnimation: 需要 target 与 state")
			return
		var actor: Variant = d.resolveActor.call(target)
		if actor == null:
			push_warning("playNpcAnimation: 找不到实体 \"%s\"" % target)
			return
		actor.play_animation(state)
	, ["target", "state"])

	executor.register("setEntityEnabled", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		if target.is_empty():
			push_warning("setEntityEnabled: missing target")
			return
		if not p.has("enabled") or p.enabled == null:
			push_warning("setEntityEnabled: missing enabled")
			return
		var enabled: Variant = _parse_loose_boolean_param(p.enabled)
		if enabled == null:
			push_warning("setEntityEnabled: invalid enabled %s" % _js_string(p.enabled))
			return
		if d.sceneManager.get_npc_by_id(target) != null:
			d.sceneManager.set_entity_session_enabled("npc", target, enabled)
			return
		var actor: Variant = d.resolveActor.call(target)
		if actor == null:
			push_warning("setEntityEnabled: no entity \"%s\"" % target)
			return
		actor.set_visible(enabled)
	, ["target", "enabled"])

	executor.register("openShop", func(p: Dictionary, _zctx: Variant) -> void:
		d.stateController.set_state(RuntimeDataTypes.UI_OVERLAY)
		d.shopUI.open_shop(p.get("shopId"))
	, ["shopId"])

	executor.register("pickup", func(p: Dictionary, _zctx: Variant) -> void:
		if _js_boolean(p.get("isCurrency", false)):
			var amount: Variant = _resolve_currency_amount_param(p.get("count"), d.resolveDisplayText, "pickup")
			if amount == null:
				return
			d.inventoryManager.add_coins(amount)
			d.pickupNotification.show(p.get("itemName"), amount)
			return
		if not d.inventoryManager.add_item(p.get("itemId"), p.get("count")):
			return
		d.pickupNotification.show(p.get("itemName"), p.get("count"))
	, ["itemId", "itemName", "count", "isCurrency"])

	var prepare_scene_switch := func() -> void:
		d.pickupNotification.force_cleanup()
		if d.inspectBox.is_open():
			d.inspectBox.close()

	executor.register("switchScene", func(p: Dictionary, _zctx: Variant) -> void:
		var previous: String = d.stateController.current_state
		d.stateController.set_state(RuntimeDataTypes.CUTSCENE)
		prepare_scene_switch.call()
		var ok: Variant = await d.sceneManager.switch_scene(p.get("targetScene"), p.get("targetSpawnPoint", ""))
		if ok == false:
			push_warning("ActionRegistry: switchScene failed")
		if d.stateController.current_state == RuntimeDataTypes.CUTSCENE:
			d.stateController.set_state(previous)
	, ["targetScene", "targetSpawnPoint"])

	executor.register("changeScene", func(p: Dictionary, _zctx: Variant) -> void:
		var previous: String = d.stateController.current_state
		d.stateController.set_state(RuntimeDataTypes.CUTSCENE)
		prepare_scene_switch.call()
		var camera_position: Variant = null
		if (p.get("cameraX") is int or p.get("cameraX") is float) and (p.get("cameraY") is int or p.get("cameraY") is float):
			camera_position = {"x": p.cameraX, "y": p.cameraY}
		var ok: Variant = await d.sceneManager.switch_scene(p.get("targetScene"), p.get("targetSpawnPoint", ""), camera_position)
		if ok == false:
			push_warning("ActionRegistry: changeScene failed")
		if d.stateController.current_state == RuntimeDataTypes.CUTSCENE:
			d.stateController.set_state(previous)
	, ["targetScene", "targetSpawnPoint", "cameraX", "cameraY"])

	executor.register("shopPurchase", func(p: Dictionary, _zctx: Variant) -> void:
		var item_id: Variant = p.get("itemId")
		var price: Variant = p.get("price")
		if not d.inventoryManager.remove_coins(price):
			d.eventBus.emit("notification:show", {
				"text": d.stringsProvider.get_text("notifications", "currencyInsufficient"),
				"type": "warning",
			})
			return
		if not d.inventoryManager.add_item(item_id, 1):
			d.inventoryManager.add_coins(price)
			return
		var definition: Variant = d.inventoryManager.get_item_def(item_id)
		d.eventBus.emit("notification:show", {
			"text": d.stringsProvider.get_text("notifications", "shopPurchased", {"name": definition.get("name", item_id) if definition is Dictionary else item_id}),
			"type": "info",
		})
	, ["itemId", "price"])

	executor.register("inventoryDiscard", func(p: Dictionary, _zctx: Variant) -> void:
		d.inventoryManager.discard_item(p.get("itemId"))
	, ["itemId"])

	executor.register("setPlayerAvatar", func(p: Dictionary, _zctx: Variant) -> void:
		var path := _nullish_string(p.get("animManifest")).strip_edges()
		if path.is_empty():
			var bundle_id := _nullish_string(p.get("bundleId")).strip_edges()
			if not bundle_id.is_empty():
				path = "/resources/runtime/animation/%s/anim.json" % bundle_id
		if path.is_empty():
			push_warning("setPlayerAvatar: 需要 params.animManifest 或 params.bundleId")
			return
		var state_map: Variant = null
		var raw: Variant = p.get("stateMap")
		if raw is Dictionary:
			var output := {}
			for key: Variant in raw:
				var value: Variant = raw[key]
				if value is String and not value.strip_edges().is_empty():
					output[key] = value.strip_edges()
			if not output.is_empty():
				state_map = output
		var portrait_slug: Variant = null
		if p.get("portraitSlug") is String and not p.portraitSlug.strip_edges().is_empty():
			portrait_slug = p.portraitSlug.strip_edges()
		await d.applyPlayerAvatar.call(path, state_map, portrait_slug)
	, ["animManifest", "bundleId", "stateMap", "portraitSlug"])

	executor.register("resetPlayerAvatar", func(_p: Dictionary, _zctx: Variant) -> void:
		await d.resetPlayerAvatar.call()
	, [])

	executor.register("setSceneDepthFloorOffset", func(p: Dictionary, _zctx: Variant) -> void:
		var value: Variant = _js_number_param(p, "floor_offset")
		if value == null:
			push_warning("setSceneDepthFloorOffset: params.floor_offset 需为有限数值")
			return
		d.setSceneDepthFloorOffset.call(float(value))
	, ["floor_offset"])

	executor.register("resetSceneDepthFloorOffset", func(_p: Dictionary, _zctx: Variant) -> void:
		d.resetSceneDepthFloorOffset.call()
	, [])

	executor.register("setCameraZoom", func(p: Dictionary, _zctx: Variant) -> void:
		var zoom: Variant = _js_number_param(p, "zoom")
		if zoom == null or float(zoom) <= 0.0:
			push_warning("setCameraZoom: params.zoom 需为有限正数")
			return
		d.setCameraZoom.call(float(zoom))
	, ["zoom"])

	executor.register("restoreSceneCameraZoom", func(_p: Dictionary, _zctx: Variant) -> void:
		d.restoreSceneCameraZoom.call()
	, [])

	executor.register("fadingZoom", func(p: Dictionary, _zctx: Variant) -> void:
		var zoom: Variant = _js_number_param(p, "zoom")
		if zoom == null or float(zoom) <= 0.0:
			push_warning("fadingZoom: params.zoom 需为有限正数")
			return
		await d.cutsceneManager.fading_camera_zoom(float(zoom), _parse_duration_ms_param(p, 600.0))
	, ["zoom", "durationMs"])

	executor.register("fadingRestoreSceneCameraZoom", func(p: Dictionary, _zctx: Variant) -> void:
		await d.fadingRestoreSceneCameraZoom.call(_parse_duration_ms_param(p, 600.0))
	, ["durationMs"])

	executor.register("stopNpcPatrol", func(p: Dictionary, _zctx: Variant) -> void:
		var id: String = p.npcId.strip_edges() if p.get("npcId") is String else ""
		if id.is_empty():
			push_warning("stopNpcPatrol: missing or empty npcId")
			return
		d.stopNpcPatrol.call(id)
	, ["npcId"])

	executor.register("persistNpcDisablePatrol", func(p: Dictionary, _zctx: Variant) -> void:
		var id: String = p.npcId.strip_edges() if p.get("npcId") is String else ""
		if id.is_empty():
			push_warning("persistNpcDisablePatrol: missing or empty npcId")
			return
		d.sceneManager.merge_persistent_npc_state(id, {"patrolDisabled": true})
		d.stopNpcPatrol.call(id)
	, ["npcId"])

	executor.register("persistNpcEnablePatrol", func(p: Dictionary, _zctx: Variant) -> void:
		var id: String = p.npcId.strip_edges() if p.get("npcId") is String else ""
		if id.is_empty():
			push_warning("persistNpcEnablePatrol: missing or empty npcId")
			return
		d.sceneManager.merge_persistent_npc_state(id, {"patrolDisabled": false})
		d.startNpcPatrol.call(id)
	, ["npcId"])

	executor.register("persistNpcEntityEnabled", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		if target.is_empty():
			push_warning("persistNpcEntityEnabled: missing target")
			return
		if not p.has("enabled") or p.enabled == null:
			push_warning("persistNpcEntityEnabled: missing enabled")
			return
		var enabled: Variant = _parse_loose_boolean_param(p.enabled)
		if enabled == null:
			push_warning("persistNpcEntityEnabled: invalid enabled %s" % _js_string(p.enabled))
			return
		d.sceneManager.merge_persistent_npc_state(target, {"enabled": enabled})
		var actor: Variant = d.resolveActor.call(target)
		if actor != null:
			actor.set_visible(enabled)
		else:
			push_warning("persistNpcEntityEnabled: no entity \"%s\"" % target)
	, ["target", "enabled"])

	executor.register("persistHotspotEnabled", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var hotspot_id := _nullish_string(p.get("hotspotId")).strip_edges()
		if scene_id.is_empty() or hotspot_id.is_empty():
			push_warning("persistHotspotEnabled: 需要 sceneId、hotspotId")
			return
		if not p.has("enabled") or p.enabled == null:
			push_warning("persistHotspotEnabled: missing enabled")
			return
		var enabled: Variant = _parse_loose_boolean_param(p.enabled)
		if enabled == null:
			push_warning("persistHotspotEnabled: invalid enabled %s" % _js_string(p.enabled))
			return
		await d.setSceneEntityField.call(scene_id, "hotspot", hotspot_id, "enabled", enabled)
	, ["sceneId", "hotspotId", "enabled"])

	executor.register("setZoneEnabled", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var zone_id := _nullish_string(p.get("zoneId")).strip_edges()
		if scene_id.is_empty() or zone_id.is_empty():
			push_warning("setZoneEnabled: 需要 sceneId、zoneId")
			return
		var enabled: Variant = _parse_loose_boolean_param(p.get("enabled"))
		if enabled == null:
			push_warning("setZoneEnabled: missing or invalid enabled")
			return
		d.sceneManager.set_zone_enabled_session(scene_id, zone_id, enabled)
	, ["sceneId", "zoneId", "enabled"])

	executor.register("persistZoneEnabled", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var zone_id := _nullish_string(p.get("zoneId")).strip_edges()
		if scene_id.is_empty() or zone_id.is_empty():
			push_warning("persistZoneEnabled: 需要 sceneId、zoneId")
			return
		var enabled: Variant = _parse_loose_boolean_param(p.get("enabled"))
		if enabled == null:
			push_warning("persistZoneEnabled: missing or invalid enabled")
			return
		d.sceneManager.merge_persistent_zone_enabled(scene_id, zone_id, enabled)
	, ["sceneId", "zoneId", "enabled"])

	executor.register("setSceneEntityPosition", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var kind := "hotspot" if _nullish_string(p.get("entityKind")).strip_edges().to_lower() == "hotspot" else "npc"
		var entity_id := _nullish_string(p.get("entityId")).strip_edges()
		var x: Variant = _js_number_param(p, "x")
		var y: Variant = _js_number_param(p, "y")
		if scene_id.is_empty() or entity_id.is_empty() or x == null or y == null:
			push_warning("setSceneEntityPosition: 需要 sceneId、entityId 与有限数值 x/y")
			return
		var rounded_x := roundf(float(x) * 100.0) / 100.0
		var rounded_y := roundf(float(y) * 100.0) / 100.0
		await d.setSceneEntityField.call(scene_id, kind, entity_id, "x", rounded_x)
		await d.setSceneEntityField.call(scene_id, kind, entity_id, "y", rounded_y)
	, ["sceneId", "entityKind", "entityId", "x", "y"])

	executor.register("persistNpcAt", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var x: Variant = _js_number_param(p, "x")
		var y: Variant = _js_number_param(p, "y")
		if target.is_empty() or x == null or y == null:
			push_warning("persistNpcAt: 需要 target、有限数值 x/y")
			return
		d.sceneManager.merge_persistent_npc_state(target, {"x": x, "y": y})
		var npc: Variant = d.sceneManager.get_npc_by_id(target)
		if npc != null:
			npc.set_x(float(x))
			npc.set_y(float(y))
		else:
			push_warning("persistNpcAt:当前场景无 NPC \"%s\"" % target)
	, ["target", "x", "y"])

	var persist_npc_anim_state_handler := func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var state := _nullish_string(p.get("state")).strip_edges()
		if target.is_empty() or state.is_empty():
			push_warning("persistNpcAnimState: 需要 target 与 state")
			return
		d.sceneManager.merge_persistent_npc_state(target, {"animState": state})
		var actor: Variant = d.resolveActor.call(target)
		if actor != null:
			actor.play_animation(state)
		else:
			push_warning("persistNpcAnimState: 找不到实体 \"%s\"" % target)
	executor.register("persistNpcAnimState", persist_npc_anim_state_handler, ["target", "state"])
	executor.register("persistPlayNpcAnimation", persist_npc_anim_state_handler, ["target", "state"])

	executor.register("fadeWorldToBlack", func(p: Dictionary, _zctx: Variant) -> void:
		var ok: Variant = await d.cutsceneManager.fade_world_to_black(_parse_duration_ms_param(p, 600.0))
		if ok == false:
			push_warning("ActionRegistry: fadeWorldToBlack failed")
	, ["durationMs"])

	executor.register("fadeWorldFromBlack", func(p: Dictionary, _zctx: Variant) -> void:
		var ok: Variant = await d.cutsceneManager.fade_world_from_black(_parse_duration_ms_param(p, 600.0))
		if ok == false:
			push_warning("ActionRegistry: fadeWorldFromBlack failed")
	, ["durationMs"])

	executor.register("showOverlayImage", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		var raw_image := _nullish_string(p.get("image")).strip_edges()
		var image: String = d.resolveOverlayImagePath.call(raw_image)
		if id.is_empty() or image.is_empty():
			push_warning("showOverlayImage: 需要 id 与 image")
			return
		var x: Variant = _js_number_param(p, "xPercent")
		var y: Variant = _js_number_param(p, "yPercent")
		var width: Variant = _js_number_param(p, "widthPercent")
		if x == null or y == null or width == null:
			push_warning("showOverlayImage: xPercent / yPercent / widthPercent 须为数值")
			return
		var ok: Variant = await d.showOverlayImage.call(id, image, float(x), float(y), float(width))
		if ok == false:
			push_warning("ActionRegistry: showOverlayImage failed")
	, ["id", "image", "xPercent", "yPercent", "widthPercent"])

	executor.register("setHotspotDisplayImage", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var hotspot_id := _nullish_string(p.get("hotspotId")).strip_edges()
		var image := _nullish_string(p.get("image")).strip_edges()
		if scene_id.is_empty() or hotspot_id.is_empty() or image.is_empty():
			push_warning("setHotspotDisplayImage: 需要 sceneId、hotspotId 与 image")
			return
		var world_width: Variant = _optional_positive_number(p.get("worldWidth"))
		var world_height: Variant = _optional_positive_number(p.get("worldHeight"))
		var facing_raw := _nullish_string(p.get("facing")).strip_edges().to_lower()
		var facing: Variant = facing_raw if facing_raw in ["left", "right"] else null
		if not facing_raw.is_empty() and facing == null:
			push_warning("setHotspotDisplayImage: facing 须为 left 或 right，已忽略 %s" % [p.get("facing")])
		await d.setHotspotDisplayImage.call(scene_id, hotspot_id, image, world_width, world_height, facing)
	, ["sceneId", "hotspotId", "image", "worldWidth", "worldHeight", "facing"])

	executor.register("tempSetHotspotDisplayFacing", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var hotspot_id := _nullish_string(p.get("hotspotId")).strip_edges()
		if scene_id.is_empty() or hotspot_id.is_empty():
			push_warning("tempSetHotspotDisplayFacing: 需要 sceneId、hotspotId")
			return
		var facing := _nullish_string(p.get("facing")).strip_edges().to_lower()
		if facing not in ["left", "right", "restore"]:
			push_warning("tempSetHotspotDisplayFacing: facing 须为 left、right 或 restore %s" % [p.get("facing")])
			return
		d.tempSetHotspotDisplayFacing.call(scene_id, hotspot_id, facing)
	, ["sceneId", "hotspotId", "facing"])

	executor.register("setEntityField", func(p: Dictionary, _zctx: Variant) -> void:
		var scene_id := _nullish_string(p.get("sceneId")).strip_edges()
		var entity_kind := _nullish_string(p.get("entityKind")).strip_edges()
		var entity_id := _nullish_string(p.get("entityId")).strip_edges()
		var field_name := _nullish_string(p.get("fieldName")).strip_edges()
		if entity_kind not in ["npc", "hotspot"]:
			push_warning("setEntityField: entityKind 必须是 npc 或 hotspot")
			return
		if scene_id.is_empty() or entity_id.is_empty() or field_name.is_empty():
			push_warning("setEntityField: 需要 sceneId、entityId、fieldName")
			return
		await d.setSceneEntityField.call(scene_id, entity_kind, entity_id, field_name, p.get("value"))
	, ["sceneId", "entityKind", "entityId", "fieldName", "value"])

	executor.register("hideOverlayImage", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("hideOverlayImage: 需要 id")
			return
		d.hideOverlayImage.call(id)
	, ["id"])

	executor.register("blendOverlayImage", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		var raw_from := _nullish_string(p.get("fromImage")).strip_edges()
		var raw_to := _nullish_string(p.get("toImage")).strip_edges()
		var from_image: String = d.resolveOverlayImagePath.call(raw_from)
		var to_image: String = d.resolveOverlayImagePath.call(raw_to)
		if id.is_empty() or from_image.is_empty() or to_image.is_empty():
			push_warning("blendOverlayImage: 需要 id、fromImage、toImage")
			return
		var x: Variant = _js_number_param(p, "xPercent")
		var y: Variant = _js_number_param(p, "yPercent")
		var width: Variant = _js_number_param(p, "widthPercent")
		if x == null or y == null or width == null:
			push_warning("blendOverlayImage: xPercent / yPercent / widthPercent 须为数值")
			return
		var duration: Variant = _js_number(_nullish_param(p, "durationMs", 600))
		var duration_ms := float(duration) if duration != null and float(duration) >= 0.0 else 600.0
		var delay: Variant = _js_number(p.get("delayMs", 0))
		var delay_ms := float(delay) if delay != null and float(delay) >= 0.0 else 0.0
		var ok: Variant = await d.blendOverlayImage.call(id, from_image, to_image, float(x), float(y), float(width), duration_ms, delay_ms)
		if ok == false:
			push_warning("ActionRegistry: blendOverlayImage failed")
	, ["id", "fromImage", "toImage", "durationMs", "delayMs", "xPercent", "yPercent", "widthPercent"])

	executor.register("startDialogueGraph", func(p: Dictionary, _zctx: Variant) -> void:
		var graph_id := _nullish_string(p.get("graphId")).strip_edges()
		if graph_id.is_empty():
			push_warning("startDialogueGraph: 需要 graphId")
			return
		var entry := _nullish_string(p.get("entry")).strip_edges()
		var npc_id := _nullish_string(p.get("npcId")).strip_edges()
		var owner_type := _nullish_string(p.get("ownerType")).strip_edges()
		var owner_id := _nullish_string(p.get("ownerId")).strip_edges()
		var dim_background: bool = p.get("dimBackground") == true or _nullish_string(p.get("dimBackground")).strip_edges() == "true"
		await d.startDialogueGraph.call(graph_id, entry, npc_id, owner_type, owner_id, dim_background)
	, ["graphId", "entry", "npcId", "ownerType", "ownerId", "dimBackground"])

	executor.register("waitClickContinue", func(p: Dictionary, _zctx: Variant) -> void:
		var hint := _nullish_string(p.get("text")).strip_edges()
		await d.waitClickContinue.call(str(d.resolveDisplayText.call(hint)) if not hint.is_empty() else "")
	, ["text"])

	executor.register("playScriptedDialogue", func(p: Dictionary, _zctx: Variant) -> void:
		var raw: Variant = p.get("lines")
		if not raw is Array or raw.is_empty():
			push_warning("playScriptedDialogue: params.lines 须为非空数组")
			return
		var scripted_npc_id := _nullish_string(p.get("scriptedNpcId")).strip_edges()
		var dim: bool = p.get("dimBackground") == true
		var narrator_fallback: String = d.stringsProvider.get_text("dialogue", "narratorLabel")
		if narrator_fallback.is_empty() or narrator_fallback == "narratorLabel":
			narrator_fallback = "旁白"
		var narrator_baseline_resolved: String = d.resolveDisplayTextForPlayScripted.call(narrator_fallback, scripted_npc_id)
		var lines: Array = []
		for item: Variant in raw:
			if not item is Dictionary:
				continue
			var speaker_raw := _nullish_string(item.get("speaker")).strip_edges()
			var speaker_resolved := str(d.resolveScriptedSpeaker.call(speaker_raw, scripted_npc_id)) if not speaker_raw.is_empty() else ""
			var source_text := _nullish_string(item.get("text")).strip_edges()
			if source_text.is_empty():
				continue
			var speaker_display: String = d.resolveDisplayTextForPlayScripted.call(speaker_resolved if not speaker_resolved.is_empty() else narrator_fallback, scripted_npc_id)
			var text_display: String = d.resolveDisplayTextForPlayScripted.call(source_text, scripted_npc_id)
			var colon_result := RuntimeTextResolver.apply_dialogue_colon_speaker_from_resolved_text(speaker_display, text_display, narrator_baseline_resolved)
			var portrait_ref: Variant = _parse_scripted_portrait_ref(item.get("portrait"))
			var extras: Dictionary = d.resolveScriptedLineExtras.call(speaker_raw, portrait_ref, scripted_npc_id)
			var line := {"speaker": colon_result.speaker, "text": colon_result.text, "tags": []}
			if extras.get("portrait") != null:
				line.portrait = extras.portrait
			if extras.get("speakerEntity") != null:
				line.speakerEntity = extras.speakerEntity
			if dim:
				line.dim = true
			lines.push_back(line)
		if lines.is_empty():
			push_warning("playScriptedDialogue: 无有效台词（需要 text）")
			return
		await d.playScriptedDialogue.call(lines)
	, ["lines"])

	executor.register("waitMs", func(p: Dictionary, _zctx: Variant) -> void:
		var duration: Variant = _js_number(_nullish_param(p, "durationMs", 600))
		var milliseconds := float(duration) if duration != null and float(duration) >= 0.0 else 0.0
		if milliseconds > 0.0:
			await Engine.get_main_loop().create_timer(milliseconds / 1000.0).timeout
	, ["durationMs"])

	executor.register("moveEntityTo", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var x: Variant = _js_number_param(p, "x")
		var y: Variant = _js_number_param(p, "y")
		var speed: Variant = _js_number(p.get("speed")) if p.has("speed") else 80.0
		var movement_speed := float(speed) if speed != null and float(speed) > 0.0 else 80.0
		var segments := _parse_move_entity_waypoint_list(p.get("waypoints"))
		segments.push_back({"x": x, "y": y})
		var move_anim: Variant = null
		if p.get("moveAnimState") is String and not p.moveAnimState.strip_edges().is_empty():
			move_anim = p.moveAnimState.strip_edges()
		var face_toward_movement := _parse_face_toward_movement_param(p.get("faceTowardMovement"))
		if target.is_empty() or x == null or y == null:
			push_warning("moveEntityTo: 需要 target、有限数值 x/y")
			return
		var actor: Variant = d.resolveActor.call(target)
		if actor == null:
			push_warning("moveEntityTo: 找不到实体 \"%s\"" % target)
			return
		for point: Dictionary in segments:
			await actor.move_to(point.x, point.y, movement_speed, move_anim, face_toward_movement)
	, ["target", "x", "y", "speed", "waypoints", "moveAnimState", "faceTowardMovement"])

	executor.register("faceEntity", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		if target.is_empty():
			push_warning("faceEntity: missing target")
			return
		var actor: Variant = d.resolveActor.call(target)
		if actor == null:
			push_warning("faceEntity: 找不到实体 \"%s\"" % target)
			return
		var face_target := _nullish_string(p.get("faceTarget")).strip_edges() if p.has("faceTarget") else ""
		var direction := _nullish_string(p.get("direction")).strip_edges() if p.has("direction") else ""
		if face_target.is_empty() and direction.is_empty():
			push_warning("faceEntity: 需要 direction 或 faceTarget（至少一个）")
			return
		if not face_target.is_empty():
			var other: Variant = d.resolveActor.call(face_target)
			if other != null:
				actor.set_facing(other.get_x() - actor.get_x(), other.get_y() - actor.get_y())
		elif not direction.is_empty():
			var direction_map := {
				"left": [-1, 0], "right": [1, 0], "up": [0, -1], "down": [0, 1],
			}
			var value: Variant = direction_map.get(direction)
			if value is Array:
				actor.set_facing(value[0], value[1])
	, ["target", "direction", "faceTarget"])

	executor.register("cutsceneSpawnActor", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		var name := _nullish_string(_nullish_param(p, "name", id)).strip_edges()
		var x: Variant = _js_number_param(p, "x")
		var y: Variant = _js_number_param(p, "y")
		if id.is_empty():
			push_warning("cutsceneSpawnActor: missing id")
			return
		if x == null or y == null:
			push_warning("cutsceneSpawnActor: x/y must be finite numbers")
			return
		d.spawnCutsceneActor.call(id, name, float(x), float(y))
	, ["id", "name", "x", "y"])

	executor.register("cutsceneRemoveActor", func(p: Dictionary, _zctx: Variant) -> void:
		var id := _nullish_string(p.get("id")).strip_edges()
		if id.is_empty():
			push_warning("cutsceneRemoveActor: missing id")
			return
		d.removeCutsceneActor.call(id)
	, ["id"])

	executor.register("showEmoteAndWait", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var emote := _nullish_string(p.get("emote")).strip_edges()
		var duration := _parse_bubble_duration_param(p)
		var scene_id: String = d.sceneManager.get_current_scene_id()
		_dbg(d, "showEmoteAndWait", "开始 scene=%s target=%s emote=%s" % [scene_id if not scene_id.is_empty() else "(?)", JSON.stringify(target), JSON.stringify(emote)])
		if target.is_empty() or emote.is_empty():
			_dbg(d, "showEmoteAndWait", "中止：缺少 target 或 emote")
			push_warning("showEmoteAndWait: 需要 target 与 emote")
			return
		var subject: Variant = d.resolveEmoteTarget.call(target)
		_dbg(d, "showEmoteAndWait", "resolve=%s" % _emote_target_debug_kind(subject))
		if subject == null:
			_dbg(d, "showEmoteAndWait", "中止：resolveEmoteTarget 返回 null")
			push_warning("showEmoteAndWait: 找不到 NPC / player / 过场实体 / 当前场景热点 \"%s\"" % target)
			return
		var offset := _parse_emote_offset_params(p)
		_dbg(d, "showEmoteAndWait", "await showAndWait durMs=%s off=(%s,%s)" % [duration, offset.anchorOffsetX, offset.anchorOffsetY])
		await d.emoteBubbleManager.show_and_wait(subject, emote, duration, offset)
		_dbg(d, "showEmoteAndWait", "showAndWait 结束")
	, ["target", "emote", "duration", "anchorOffsetX", "anchorOffsetY"])

	executor.register("showSpeechBubbleAndWait", func(p: Dictionary, _zctx: Variant) -> void:
		var target := _nullish_string(p.get("target")).strip_edges()
		var raw := _speech_bubble_raw_text(p)
		var duration := _parse_bubble_duration_param(p)
		var scene_id: String = d.sceneManager.get_current_scene_id()
		_dbg(d, "showSpeechBubbleAndWait", "scene=%s target=%s rawLen=%s" % [scene_id if not scene_id.is_empty() else "(?)", JSON.stringify(target), raw.length()])
		if target.is_empty() or raw.is_empty():
			push_warning("showSpeechBubbleAndWait: 需要 target 与 text")
			return
		var text := str(d.resolveDisplayText.call(raw)).strip_edges()
		if text.is_empty():
			push_warning("showSpeechBubbleAndWait: 解析后文案为空")
			return
		var subject: Variant = d.resolveEmoteTarget.call(target)
		if subject == null:
			push_warning("showSpeechBubbleAndWait: 找不到 NPC / player / 过场实体 / 当前场景热点 \"%s\"" % target)
			return
		var offset := _parse_emote_offset_params(p)
		_dbg(d, "showSpeechBubbleAndWait", "await showAndWait durMs=%s" % duration)
		await d.emoteBubbleManager.show_and_wait(subject, text, duration, offset)
		_dbg(d, "showSpeechBubbleAndWait", "showAndWait 结束")
	, ["target", "text", "duration", "anchorOffsetX", "anchorOffsetY"])

	executor.register("revealDocument", func(p: Dictionary, _zctx: Variant) -> void:
		await d.documentRevealManager.check_and_reveal(_nullish_string(p.get("documentId")))
	, ["documentId"])


static func audit_action_registrations_against_manifest(executor: RuntimeActionExecutor) -> Array[String]:
	var problems: Array[String] = []
	var manifest: Dictionary = RuntimeActionParamManifestScript.ACTION_PARAM_MANIFEST
	var registered := {}
	for type: String in executor.get_registered_action_types():
		registered[type] = true
	for type: Variant in manifest:
		var entry: Dictionary = manifest[type]
		if not registered.has(type):
			problems.push_back("manifest 收录但运行时未注册: %s" % type)
			continue
		var param_names := {}
		var names: Variant = executor.get_param_names(type)
		if names is Array:
			for name: Variant in names:
				param_names[name] = true
		var union := {}
		for name: Variant in entry.get("required", []):
			union[name] = true
		for name: Variant in entry.get("optional", []):
			union[name] = true
		for required: Variant in entry.get("required", []):
			if not param_names.has(required):
				problems.push_back("必填参数漂移: %s.%s 在 manifest.required 但不在 executor paramNames" % [type, required])
		for param_name: Variant in param_names:
			if not union.has(param_name):
				problems.push_back("参数漂移: %s.%s 在 executor paramNames 但 manifest 未收录" % [type, param_name])
	for type: Variant in registered:
		if not manifest.has(type):
			problems.push_back("运行时注册但 manifest 未收录: %s" % type)
	return problems


static func _js_number(value: Variant) -> Variant:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value) if is_finite(float(value)) else null
	if value is Array:
		if value.is_empty():
			return 0.0
		if value.size() == 1:
			return _js_number(value[0])
		return null
	if value is Dictionary or value is Object:
		return null
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() and is_finite(text.to_float()) else null


static func _js_number_param(params: Dictionary, key: String) -> Variant:
	return _js_number(params[key]) if params.has(key) else null


static func _nullish_param(params: Dictionary, key: String, fallback: Variant) -> Variant:
	return params[key] if params.has(key) and params[key] != null else fallback


static func _js_boolean(value: Variant) -> bool:
	if value == null:
		return false
	if value is bool:
		return value
	if value is int or value is float:
		return is_finite(float(value)) and float(value) != 0.0
	if value is String:
		return not value.is_empty()
	return true


static func _optional_positive_number(value: Variant) -> Variant:
	if value == null or (value is String and value.is_empty()):
		return null
	var number: Variant = _js_number(value)
	return number if number != null and float(number) > 0.0 else null


static func _nullish_string(value: Variant) -> String:
	return "" if value == null else str(value)


static func _js_string(value: Variant) -> String:
	if value == null:
		return "null"
	if value is bool:
		return "true" if value else "false"
	if value is float and is_finite(value) and value == floorf(value):
		return str(int(value))
	return str(value)


static func _emote_target_debug_kind(subject: Variant) -> String:
	if subject == null:
		return "null"
	if "entity_id" in subject:
		return "ICutsceneActor(%s)" % subject.entity_id
	return subject.get_class() if subject is Object else "unknown anchor"
