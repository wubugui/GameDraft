class_name RuntimeNarrativeGraphCompiler
extends RefCounted


static func compile(data: Variant) -> Array:
	if not data is Dictionary:
		return []
	if data.get("compositions") is Array:
		var result: Array = []
		for raw_composition: Variant in data.compositions:
			if not raw_composition is Dictionary:
				continue
			var main_graph: Variant = raw_composition.get("mainGraph")
			if is_narrative_graph(main_graph):
				result.push_back(main_graph)
			var elements: Variant = raw_composition.get("elements", [])
			if not elements is Array:
				continue
			for raw_element: Variant in elements:
				if not raw_element is Dictionary:
					continue
				if raw_element.get("kind") not in ["wrapperGraph", "scenarioSubgraph"]:
					continue
				var graph: Variant = raw_element.get("graph")
				if is_narrative_graph(graph):
					result.push_back(graph)
		return result
	var legacy: Variant = data.get("graphs")
	if not legacy is Array:
		return []
	return legacy.filter(func(graph: Variant) -> bool: return is_narrative_graph(graph))


static func is_narrative_graph(value: Variant) -> bool:
	return value is Dictionary \
		and value.get("id") is String \
		and value.get("initialState") is String \
		and value.get("states") is Dictionary \
		and value.get("transitions") is Array
