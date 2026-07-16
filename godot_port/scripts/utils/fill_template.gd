class_name RuntimeFillTemplate
extends RefCounted


static func fill_token(text: String, token: String, value: String) -> String:
	var index := text.find(token)
	if index < 0:
		return text
	return text.substr(0, index) + value + text.substr(index + token.length())


static func fill_template(text: String, replacements: Dictionary) -> String:
	var result := text
	for token: Variant in replacements:
		result = fill_token(result, str(token), str(replacements[token]))
	return result
