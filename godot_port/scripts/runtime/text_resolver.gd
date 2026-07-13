class_name RuntimeTextResolver
extends RefCounted

const MAX_RESOLVE_DEPTH := 4

var _string_tag := _compile("\\[tag:string:([^:]+):([^\\]]+)\\]")
var _flag_tag := _compile("\\[tag:flag:([^\\]]+)\\]")
var _item_tag := _compile("\\[tag:item:([^\\]]+)\\]")
var _npc_tag := _compile("\\[tag:npc:([^\\]]+)\\]")
var _player_tag := _compile("\\[tag:player\\]")
var _quest_tag := _compile("\\[tag:quest:([^\\]]+)\\]")
var _rule_tag := _compile("\\[tag:rule:([^\\]]+)\\]")
var _scene_tag := _compile("\\[tag:scene:([^\\]]+)\\]")
var _image_tag := _compile("\\[img:([^\\]]+)\\]")


func resolve_text(raw: Variant, context: Dictionary) -> String:
	if raw == null or str(raw).is_empty():
		return ""
	var output := str(raw).replace("［", "[").replace("］", "]")
	for _pass in MAX_RESOLVE_DEPTH:
		var previous := output
		output = _replace_all(output, _string_tag, func(match: RegExMatch) -> String:
			return _call_string(context.get("stringsRaw"), [match.get_string(1), match.get_string(2)], match.get_string(0))
		)
		output = _replace_all(output, _flag_tag, func(match: RegExMatch) -> String:
			var key := match.get_string(1).strip_edges()
			if key.is_empty():
				return match.get_string(0)
			var flag_store: Variant = context.get("flagStore")
			var value: Variant = flag_store.call("get_value", key) if flag_store != null and flag_store.has_method("get_value") else null
			var has_value: bool = flag_store.call("has_value", key) if flag_store != null and flag_store.has_method("has_value") else value != null
			return _format_flag(value, has_value, context)
		)
		output = _replace_all(output, _item_tag, func(match: RegExMatch) -> String:
			var id := match.get_string(1).strip_edges()
			if id.is_empty():
				return match.get_string(0)
			var names: Variant = context.get("itemNames", {})
			if names is Dictionary and names.has(id) and not str(names[id]).is_empty():
				return str(names[id])
			return _apply_vars(_strings_raw(context, "gameTags", "unknownItem"), {"id": id})
		)
		output = _replace_all(output, _npc_tag, func(match: RegExMatch) -> String:
			var id := match.get_string(1).strip_edges()
			if id.is_empty() or id == "@context":
				id = str(context.get("contextNpcId", "")).strip_edges()
			if id.is_empty():
				return "…"
			var name := _call_optional_string(context.get("npcName"), [id])
			return name if not name.is_empty() else id
		)
		output = _replace_all(output, _player_tag, func(_match: RegExMatch) -> String:
			return _call_optional_string(context.get("playerDisplayName"), [])
		)
		output = _replace_named_fallback(output, _quest_tag, "questTitle", context)
		output = _replace_named_fallback(output, _rule_tag, "ruleName", context)
		output = _replace_named_fallback(output, _scene_tag, "sceneDisplayName", context)
		if output == previous:
			break
	return output


func split_speaker_body_after_resolve(resolved: String) -> Dictionary:
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
	return {} if speaker.is_empty() or body.is_empty() else {"speaker": speaker, "body": body, "separator": separator}


func apply_dialogue_colon_speaker(resolved_explicit_speaker: String, text_resolved_display: String, narrator_baseline_resolved: String) -> Dictionary:
	var split := split_speaker_body_after_resolve(text_resolved_display)
	if not split.is_empty() and resolved_explicit_speaker == narrator_baseline_resolved:
		return {"speaker": split.speaker, "text": split.body}
	return {"speaker": resolved_explicit_speaker, "text": text_resolved_display}


func resolve_content_image_url(ref: String, locator: RuntimeResourceLocator) -> String:
	return locator.media_url_from_short_path(ref)


func parse_rich_segments(raw: String, locator: RuntimeResourceLocator) -> Array:
	var result: Array = []
	var offset := 0
	for match: RegExMatch in _image_tag.search_all(raw):
		var before := raw.substr(offset, match.get_start() - offset).strip_edges()
		if not before.is_empty():
			result.push_back({"type": "text", "text": before})
		result.push_back({"type": "image", "path": match.get_string(1), "url": resolve_content_image_url(match.get_string(1), locator)})
		offset = match.get_end()
	var tail := raw.substr(offset).strip_edges()
	if not tail.is_empty():
		result.push_back({"type": "text", "text": tail})
	return result


func _replace_named_fallback(text: String, regex: RegEx, callback_name: String, context: Dictionary) -> String:
	return _replace_all(text, regex, func(match: RegExMatch) -> String:
		var id := match.get_string(1).strip_edges()
		if id.is_empty():
			return match.get_string(0)
		var value := _call_optional_string(context.get(callback_name), [id])
		return value if not value.is_empty() else id
	)


func _format_flag(value: Variant, has_value: bool, context: Dictionary) -> String:
	if not has_value:
		return _strings_raw(context, "gameTags", "flagUnset")
	if value is bool:
		return _strings_raw(context, "gameTags", "flagTrue" if value else "flagFalse")
	if value is float and value == floor(value):
		return str(int(value))
	return str(value)


func _strings_raw(context: Dictionary, category: String, key: String) -> String:
	return _call_string(context.get("stringsRaw"), [category, key], key)


func _call_string(callback: Variant, arguments: Array, fallback: String) -> String:
	if callback is Callable and callback.is_valid():
		return str(callback.callv(arguments))
	return fallback


func _call_optional_string(callback: Variant, arguments: Array) -> String:
	if callback is Callable and callback.is_valid():
		var value: Variant = callback.callv(arguments)
		return "" if value == null else str(value)
	return ""


func _apply_vars(template: String, variables: Dictionary) -> String:
	var regex := _compile("\\{(\\w+)\\}")
	return _replace_all(template, regex, func(match: RegExMatch) -> String:
		var key := match.get_string(1)
		return str(variables[key]) if variables.has(key) else match.get_string(0)
	)


func _replace_all(text: String, regex: RegEx, replacer: Callable) -> String:
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
