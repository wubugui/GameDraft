class_name RuntimeFlagKeys
extends RefCounted

const CURRENT_DAY := "current_day"


static func hotspot_picked_up(hotspot_id: String) -> String:
	return "picked_up_%s" % hotspot_id


static func rule_used(rule_id: String) -> String:
	return "rule_used_%s" % rule_id


static func archive_character(character_id: String) -> String:
	return "archive_character_%s" % character_id
