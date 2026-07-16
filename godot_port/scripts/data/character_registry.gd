class_name RuntimeCharacterRegistry
extends RefCounted


static func build_character_registry(characters: Variant) -> Dictionary:
	var output: Dictionary = {}
	if characters is Array:
		for character: Variant in characters:
			if not character is Dictionary:
				continue
			var id := str(character.get("id", "")).strip_edges()
			if not id.is_empty():
				output[id] = character
	return output


static func apply_character_defaults(definition: Dictionary, registry: Dictionary) -> Dictionary:
	var character_id := str(definition.get("characterId", "")).strip_edges()
	if character_id.is_empty():
		return definition
	var character: Variant = registry.get(character_id)
	if not character is Dictionary:
		return definition
	var output := definition.duplicate(false)
	if not _is_js_truthy(output.get("name")) and _is_js_truthy(character.get("name")):
		output["name"] = character["name"]
	if not _is_js_truthy(output.get("animFile")) and _is_js_truthy(character.get("animFile")):
		output["animFile"] = character["animFile"]
	if not _is_js_truthy(output.get("portraitSlug")) and _is_js_truthy(character.get("portraitSlug")):
		output["portraitSlug"] = character["portraitSlug"]
	return output


static func portrait_slug_from_anim_file(anim_file: Variant) -> Variant:
	if not _is_js_truthy(anim_file):
		return null
	var regex := RegEx.new()
	regex.compile("/animation/([^/]+)/anim\\.json")
	var matched := regex.search(str(anim_file))
	return matched.get_string(1) if matched != null else null


static func _is_js_truthy(value: Variant) -> bool:
	if value == null:
		return false
	if value is bool:
		return value
	if value is int:
		return value != 0
	if value is float:
		return value != 0.0 and not is_nan(value)
	if value is String:
		return not value.is_empty()
	return true
