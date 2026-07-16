class_name RuntimeAnimationSetResolver
extends RefCounted


const DEFAULT_WORLD_WIDTH := 100.0


static func effective_cell_pixel_size(
	input: Dictionary,
	texture_pixel_width: float,
	texture_pixel_height: float,
) -> Dictionary:
	var cols := maxf(1.0, float(input.get("cols")))
	var rows := maxf(1.0, float(input.get("rows")))
	var cell_w: float
	var cell_h: float
	if _is_number(input.get("cellWidth")) and float(input.get("cellWidth")) > 0.0:
		cell_w = float(input.get("cellWidth"))
	else:
		cell_w = texture_pixel_width / cols
	if _is_number(input.get("cellHeight")) and float(input.get("cellHeight")) > 0.0:
		cell_h = float(input.get("cellHeight"))
	else:
		cell_h = texture_pixel_height / rows
	return {"cellW": cell_w, "cellH": cell_h}


static func resolve_animation_world_size(
	input: Dictionary,
	texture_pixel_width: float,
	texture_pixel_height: float,
) -> Dictionary:
	var frame := effective_cell_pixel_size(input, texture_pixel_width, texture_pixel_height)
	var frame_w := float(frame.cellW)
	var frame_h := float(frame.cellH)
	var aspect_hw := frame_h / frame_w

	var w_raw: Variant = input.get("worldWidth")
	var h_raw: Variant = input.get("worldHeight")
	var w: Variant = w_raw if _is_number(w_raw) and float(w_raw) > 0.0 else null
	var h: Variant = h_raw if _is_number(h_raw) and float(h_raw) > 0.0 else null

	if w != null and h != null:
		return {"worldWidth": w, "worldHeight": h}
	if w != null:
		return {"worldWidth": w, "worldHeight": _round_six(float(w) * aspect_hw)}
	if h != null:
		return {"worldWidth": _round_six(float(h) / aspect_hw), "worldHeight": h}
	var world_width := DEFAULT_WORLD_WIDTH
	return {"worldWidth": world_width, "worldHeight": _round_six(world_width * aspect_hw)}


static func normalize_animation_set_def(
	input: Dictionary,
	texture_pixel_width: float,
	texture_pixel_height: float,
) -> Dictionary:
	var cell := effective_cell_pixel_size(input, texture_pixel_width, texture_pixel_height)
	var world := resolve_animation_world_size(input, texture_pixel_width, texture_pixel_height)
	var output := input.duplicate()
	output["worldWidth"] = world.worldWidth
	output["worldHeight"] = world.worldHeight
	output["cellWidth"] = _round_six(float(cell.cellW))
	output["cellHeight"] = _round_six(float(cell.cellH))
	return output


static func _is_number(value: Variant) -> bool:
	return value is int or value is float


static func _round_six(value: float) -> float:
	return floor(value * 1e6 + 0.5) / 1e6
