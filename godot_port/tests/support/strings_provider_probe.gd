extends RefCounted


static func counts(provider: RuntimeStringsProvider) -> Dictionary:
	var data: Variant = provider.get("_data")
	var leaves := 0
	if data is Dictionary:
		for category: Variant in data.values():
			if category is Dictionary:
				leaves += category.size()
	return {
		"categories": data.size() if data is Dictionary else 0,
		"leaves": leaves,
	}
