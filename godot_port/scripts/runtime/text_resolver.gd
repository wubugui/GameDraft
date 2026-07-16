class_name RuntimeTextResolver
extends RefCounted

const TAG_STRING := "\\[tag:string:([^:]+):([^\\]]+)\\]"
const TAG_FLAG := "\\[tag:flag:([^\\]]+)\\]"
const TAG_ITEM := "\\[tag:item:([^\\]]+)\\]"
const TAG_NPC := "\\[tag:npc:([^\\]]+)\\]"
const TAG_PLAYER := "\\[tag:player\\]"
const TAG_QUEST := "\\[tag:quest:([^\\]]+)\\]"
const TAG_RULE := "\\[tag:rule:([^\\]]+)\\]"
const TAG_SCENE := "\\[tag:scene:([^\\]]+)\\]"

const MAX_RESOLVE_DEPTH := 4


static func _apply_vars(template: String, variables: Variant = null) -> String:
	if not variables is Dictionary:
		return template
	return _replace_all(template, _compile("\\{(\\w+)\\}"), func(match: RegExMatch) -> String:
		var key := match.get_string(1)
		var value: Variant = variables.get(key)
		return _js_string(value) if value != null else match.get_string(0)
	)


static func _format_flag_value(value: Variant, context: Dictionary) -> String:
	if value == null:
		return _apply_vars(_strings_raw(context, "gameTags", "flagUnset"))
	if value is bool:
		return _apply_vars(_strings_raw(context, "gameTags", "flagTrue" if value else "flagFalse"))
	if value is String:
		return value
	return _js_string(value)


static func _warn_unknown_tag(kind: String, detail: String) -> void:
	push_warning("resolveText: unknown or invalid [tag:%s] %s" % [kind, detail])


static func _normalize_embedded_tags_syntax(value: String) -> String:
	return value.replace("［", "[").replace("］", "]")


static func split_speaker_body_after_resolve(resolved: String) -> Dictionary:
	if resolved.is_empty():
		return {}
	var ascii_index := resolved.find(":")
	var full_index := resolved.find("：")
	var index := -1
	var separator := "："
	if ascii_index >= 0 and (full_index < 0 or ascii_index < full_index):
		index = ascii_index
		separator = ":"
	elif full_index >= 0:
		index = full_index
	if index < 0:
		return {}
	var speaker := resolved.substr(0, index).strip_edges()
	var body := resolved.substr(index + 1).strip_edges()
	if speaker.is_empty() or body.is_empty():
		return {}
	return {"speaker": speaker, "body": body, "separator": separator}


static func apply_dialogue_colon_speaker_from_resolved_text(
	resolved_explicit_speaker: String,
	text_resolved_display: String,
	narrator_baseline_resolved: String,
) -> Dictionary:
	var split := split_speaker_body_after_resolve(text_resolved_display)
	if not split.is_empty() and resolved_explicit_speaker == narrator_baseline_resolved:
		return {"speaker": split.speaker, "text": split.body}
	return {"speaker": resolved_explicit_speaker, "text": text_resolved_display}


static func resolve_text(raw: Variant, context: Dictionary) -> String:
	if raw == null or raw == "":
		return ""
	var output := _normalize_embedded_tags_syntax(str(raw))
	for _pass in MAX_RESOLVE_DEPTH:
		var previous := output

		output = _replace_all(output, _compile(TAG_STRING), func(match: RegExMatch) -> String:
			return _strings_raw(context, match.get_string(1), match.get_string(2))
		)

		output = _replace_all(output, _compile(TAG_FLAG), func(match: RegExMatch) -> String:
			var key := match.get_string(1).strip_edges()
			if key.is_empty():
				_warn_unknown_tag("flag", "(empty)")
				return match.get_string(0)
			var flag_store: Variant = context.get("flagStore")
			return _format_flag_value(flag_store.call("get_value", key), context)
		)

		output = _replace_all(output, _compile(TAG_ITEM), func(match: RegExMatch) -> String:
			var id := match.get_string(1).strip_edges()
			if id.is_empty():
				_warn_unknown_tag("item", "(empty)")
				return match.get_string(0)
			var names: Variant = context.get("itemNames")
			if names is Dictionary and names.has(id) and names[id] != null and str(names[id]) != "":
				return str(names[id])
			return _apply_vars(_strings_raw(context, "gameTags", "unknownItem"), {"id": id})
		)

		output = _replace_all(output, _compile(TAG_NPC), func(match: RegExMatch) -> String:
			var id := match.get_string(1).strip_edges()
			if id.is_empty() or id == "@context":
				id = str(context.get("contextNpcId", "")).strip_edges()
			if id.is_empty():
				_warn_unknown_tag("npc", "no id and no context")
				return "…"
			var name := _call_optional_string(context.get("npcName"), [id])
			return name if not name.is_empty() else id
		)

		output = _replace_all(output, _compile(TAG_PLAYER), func(_match: RegExMatch) -> String:
			return _call_optional_string(context.get("playerDisplayName"), [])
		)

		output = _replace_named_fallback(output, TAG_QUEST, "quest", "questTitle", context)
		output = _replace_named_fallback(output, TAG_RULE, "rule", "ruleName", context)
		output = _replace_named_fallback(output, TAG_SCENE, "scene", "sceneDisplayName", context)

		if output == previous:
			break
	return output


static func expand_game_tags(raw: String, options: Dictionary) -> String:
	var flag_store: Variant = options.flagStore
	var strings: Callable = options.strings
	var player_display_name := func() -> String:
		var value: Variant = flag_store.call("get_value", "player_display_name")
		if value is String and not value.strip_edges().is_empty():
			return value.strip_edges()
		var fallback := str(strings.call("dialogue", "defaultProtagonistName"))
		return fallback if not fallback.is_empty() and fallback != "defaultProtagonistName" else "你"
	return resolve_text(raw, {
		"stringsRaw": func(category: String, key: String) -> String: return str(strings.call(category, key)),
		"flagStore": flag_store,
		"itemNames": options.get("itemNames"),
		"npcName": func(_id: String) -> Variant: return null,
		"playerDisplayName": player_display_name,
		"questTitle": func(_id: String) -> Variant: return null,
		"ruleName": func(_id: String) -> Variant: return null,
		"sceneDisplayName": func(_id: String) -> Variant: return null,
		"contextNpcId": "",
	})


static func _replace_named_fallback(text: String, pattern: String, kind: String, callback_name: String, context: Dictionary) -> String:
	return _replace_all(text, _compile(pattern), func(match: RegExMatch) -> String:
		var id := match.get_string(1).strip_edges()
		if id.is_empty():
			_warn_unknown_tag(kind, "(empty)")
			return match.get_string(0)
		var value := _call_optional_string(context.get(callback_name), [id])
		return value if not value.is_empty() else id
	)


static func _strings_raw(context: Dictionary, category: String, key: String) -> String:
	var callback: Callable = context.stringsRaw
	return str(callback.call(category, key))


static func _call_optional_string(callback: Variant, arguments: Array) -> String:
	if callback is Callable and callback.is_valid():
		var value: Variant = callback.callv(arguments)
		return "" if value == null else str(value)
	return ""


static func _replace_all(text: String, regex: RegEx, replacer: Callable) -> String:
	var result := ""
	var offset := 0
	for match: RegExMatch in regex.search_all(text):
		result += text.substr(offset, match.get_start() - offset)
		result += str(replacer.call(match))
		offset = match.get_end()
	return result + text.substr(offset)


static func _compile(pattern: String) -> RegEx:
	var regex := RegEx.new()
	var error := regex.compile(pattern)
	assert(error == OK)
	return regex


static func _js_string(value: Variant) -> String:
	if value is bool:
		return "true" if value else "false"
	if value is float and is_finite(value) and value == floorf(value):
		return str(int(value))
	return str(value)
