extends SceneTree

class StringsStub:
	extends RefCounted
	var player_fallback := "阿生"
	func get_text(_section: String, _key: String) -> String: return player_fallback

class FlagStoreStub:
	extends RefCounted
	var player_name: Variant = null
	func get_value(_key: String) -> Variant: return player_name

class NpcStub:
	extends RefCounted
	var def: Dictionary
	func _init(id: String, display_name: String) -> void: def = {"id": id, "name": display_name}

class SceneManagerStub:
	extends RefCounted
	var npcs := {
		"graph_npc": NpcStub.new("graph_npc", "图中人"),
		"fallback_npc": NpcStub.new("fallback_npc", "备用人"),
		"explicit_npc": NpcStub.new("explicit_npc", "指定人"),
	}
	func get_npc_by_id(id: String) -> Variant: return npcs.get(id)


func _init() -> void:
	var strings := StringsStub.new()
	var flags := FlagStoreStub.new()
	var scene_manager := SceneManagerStub.new()
	var context := {
		"strings": strings,
		"flagStore": flags,
		"sceneManager": scene_manager,
		"graphDialogueNpcId": " graph_npc ",
		"fallbackNpcId": " fallback_npc ",
	}

	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("旁白", context) == "旁白")
	flags.player_name = "  小陶  "
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("甲{{player}}乙", context) == "甲小陶乙")
	flags.player_name = null
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("{{player}}", context) == "阿生")
	strings.player_fallback = "defaultProtagonistName"
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("{{player}}", context) == "你")
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("{{npc}}/{{npc:@context}}/{{npc:explicit_npc}}", context) == "图中人/图中人/指定人")
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("{{ unknown : value }}", context) == "{{unknown : value}}")
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_display("断{{npc", context) == "断{{npc")

	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("前{{player}}后{{npc}}", context) == {"kind": "player"})
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("{{npc}}", context) == {"kind": "npc", "npcId": "graph_npc"})
	context.graphDialogueNpcId = ""
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("{{npc:@context}}", context) == {"kind": "npc", "npcId": "fallback_npc"})
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("{{ : npc : explicit_npc }}", context) == {"kind": "npc", "npcId": "explicit_npc"})
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("字面名", context) == null)
	assert(RuntimeScriptedDialogueSpeaker.resolve_scripted_speaker_entity("{{unknown}}", context) == null)

	print("ScriptedDialogueSpeaker display/entity direct-translation test: PASS")
	quit(0)
