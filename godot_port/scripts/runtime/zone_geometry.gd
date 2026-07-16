class_name RuntimeZoneGeometry
extends RefCounted


static func is_point_in_polygon(polygon: Array, px: float, py: float) -> bool:
	var count := polygon.size()
	if count < 3:
		return false
	var inside := false
	var previous := count - 1
	for index: int in count:
		var xi := float(polygon[index].x)
		var yi := float(polygon[index].y)
		var xj := float(polygon[previous].x)
		var yj := float(polygon[previous].y)
		var dy := yj - yi
		if absf(dy) >= 0.000000000001:
			var intersection := xi + ((xj - xi) * (py - yi)) / dy
			if (yi > py) != (yj > py) and px < intersection:
				inside = not inside
		previous = index
	return inside


static func point_polygon_vertical_side(polygon: Array, px: float, py: float) -> Variant:
	var count := polygon.size()
	if count < 3:
		return null
	var y_min := INF
	var y_max := -INF
	var hit_count := 0
	var previous := count - 1
	for index: int in count:
		var xi := float(polygon[index].x)
		var xj := float(polygon[previous].x)
		if (xi <= px and xj >= px) or (xj <= px and xi >= px):
			var dx := xj - xi
			var interpolation := 0.5 if absf(dx) < 0.000000000001 else (px - xi) / dx
			if interpolation >= 0.0 and interpolation <= 1.0:
				var yi := float(polygon[index].y)
				var yj := float(polygon[previous].y)
				var y_hit := yi + interpolation * (yj - yi)
				y_min = minf(y_min, y_hit)
				y_max = maxf(y_max, y_hit)
				hit_count += 1
		previous = index
	if hit_count == 0:
		return null
	if py < y_min:
		return "above"
	if py > y_max:
		return "below"
	return "inside"


static func is_valid_zone_polygon(polygon: Variant) -> bool:
	if not polygon is Array or polygon.size() < 3:
		return false
	for point: Variant in polygon:
		if not point is Dictionary or not (point.get("x") is int or point.get("x") is float) or not (point.get("y") is int or point.get("y") is float) or not is_finite(float(point.x)) or not is_finite(float(point.y)):
			return false
	return true
