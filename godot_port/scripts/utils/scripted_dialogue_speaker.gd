class_name RuntimeScriptedDialogueSpeaker
extends RefCounted


static func resolve_scripted_speaker_display(raw: Variant, context: Dictionary) -> String:
	var source := "" if raw == null else str(raw)
	if not source.contains("{{"):
		return source

	var graph_id := str(context.get("graphDialogueNpcId", "")).strip_edges()
	var fallback_id := str(context.get("fallbackNpcId", "")).strip_edges()
	var output := ""
	var offset := 0
	while offset < source.length():
		var start := source.find("{{", offset)
		if start < 0:
			output += source.substr(offset)
			break
		output += source.substr(offset, start - offset)
		var end := source.find("}}", start + 2)
		if end < 0:
			output += source.substr(start)
			break
		var inner := source.substr(start + 2, end - start - 2).strip_edges()
		offset = end + 2
		var parts := _non_empty_parts(inner)
		var kind := parts[0].to_lower() if not parts.is_empty() else ""

		if kind == "player":
			var flag_store: Variant = context.get("flagStore")
			var value: Variant = flag_store.get_value("player_display_name")
			if value is String and not value.strip_edges().is_empty():
				output += value.strip_edges()
			else:
				var strings: Variant = context.get("strings")
				var fallback := str(strings.get_text("dialogue", "defaultProtagonistName"))
				output += fallback if not fallback.is_empty() and fallback != "defaultProtagonistName" else "你"
		elif kind == "npc":
			var id_part := parts[1] if parts.size() > 1 else ""
			var use_context := id_part.is_empty() or id_part == "@context"
			var pick := (graph_id if not graph_id.is_empty() else fallback_id) if use_context else id_part
			if pick.is_empty():
				push_warning("playScriptedDialogue: {{npc}} 无可用上下文（图对话 npcId 与 scriptedNpcId 均为空），请写 {{npc:npcId}} 或在动作参数中填写 scriptedNpcId")
				output += "…"
			else:
				var scene_manager: Variant = context.get("sceneManager")
				var npc: Variant = scene_manager.get_npc_by_id(pick)
				output += str(npc.def.get("name", pick)) if npc != null else pick
		else:
			output += "{{%s}}" % inner
	return output


static func resolve_scripted_speaker_entity(raw: Variant, context: Dictionary) -> Variant:
	var source := "" if raw == null else str(raw)
	var start := source.find("{{")
	if start < 0:
		return null
	var end := source.find("}}", start + 2)
	if end < 0:
		return null
	var parts := _non_empty_parts(source.substr(start + 2, end - start - 2))
	var kind := parts[0].to_lower() if not parts.is_empty() else ""
	if kind == "player":
		return {"kind": "player"}
	if kind == "npc":
		var id_part := parts[1] if parts.size() > 1 else ""
		var use_context := id_part.is_empty() or id_part == "@context"
		var graph_id := str(context.get("graphDialogueNpcId", "")).strip_edges()
		var fallback_id := str(context.get("fallbackNpcId", "")).strip_edges()
		var pick := ((graph_id if not graph_id.is_empty() else fallback_id) if use_context else id_part).strip_edges()
		return {"kind": "npc", "npcId": pick} if not pick.is_empty() else null
	return null


static func _non_empty_parts(value: String) -> Array[String]:
	var output: Array[String] = []
	for raw_part: String in value.split(":"):
		var part := raw_part.strip_edges()
		if not part.is_empty():
			output.push_back(part)
	return output
