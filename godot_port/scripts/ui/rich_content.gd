class_name RuntimeRichContent
extends RefCounted

const IMAGE_TAG := "\\[img:([^\\]]+)\\]"


static func resolve_content_image_url(ref: String, locator: RuntimeResourceLocator) -> String:
	return locator.media_url_from_short_path(ref)


static func parse_segments(raw: String) -> Array:
	var regex := RegEx.new()
	assert(regex.compile(IMAGE_TAG) == OK)
	var segments: Array = []
	var offset := 0
	for match: RegExMatch in regex.search_all(raw):
		var before := raw.substr(offset, match.get_start() - offset).strip_edges()
		if not before.is_empty():
			segments.push_back({"type": "text", "text": before})
		segments.push_back({"type": "image", "path": match.get_string(1)})
		offset = match.get_end()
	var tail := raw.substr(offset).strip_edges()
	if not tail.is_empty():
		segments.push_back({"type": "text", "text": tail})
	return segments
