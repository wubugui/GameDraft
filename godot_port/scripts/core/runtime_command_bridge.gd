class_name RuntimeCommandBridge
extends Node

const PROTOCOL_VERSION := 1

var _snapshot_builder: Callable
var _command_executor: Callable
var _boot_id := ""
var _last_results: Array = []


func bind(snapshot_builder: Callable, boot_id: String, command_executor: Callable = Callable()) -> void:
	_snapshot_builder = snapshot_builder
	_boot_id = boot_id
	_command_executor = command_executor


func _ready() -> void:
	call_deferred("_consume_parity_request")


func _consume_parity_request() -> void:
	var options := _user_options()
	var request_path := str(options.get("parity-request", ""))
	var response_path := str(options.get("parity-response", ""))
	if request_path.is_empty() and response_path.is_empty():
		return
	if request_path.is_empty() or response_path.is_empty():
		push_error("Godot parity bridge requires both --parity-request and --parity-response")
		get_tree().quit(2)
		return
	var request := _read_json(request_path)
	var response := await _execute_request(request)
	if not _write_json_atomic(response_path, response):
		get_tree().quit(3)
		return
	if options.has("parity-quit"):
		get_tree().quit(0 if bool(response.get("ok", false)) else 1)


func _execute_request(request: Dictionary) -> Dictionary:
	var request_id := str(request.get("requestId", ""))
	if int(request.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		return _response(request_id, false, [], "unsupported protocolVersion")
	var operations: Variant = request.get("operations", [])
	if not operations is Array:
		return _response(request_id, false, [], "operations must be an array")
	var results: Array = []
	for raw_operation: Variant in operations:
		if not raw_operation is Dictionary:
			results.push_back(_control_result("unknown", false, "operation must be an object"))
			continue
		var operation: Dictionary = raw_operation
		match str(operation.get("type", "")):
			"ping":
				results.push_back(_control_result("ping", true, "pong"))
			"captureSnapshot":
				results.push_back(_capture_operation(operation))
			"runtimeCommand":
				results.push_back(await _runtime_command_operation(operation))
			_:
				results.push_back(_control_result(str(operation.get("type", "unknown")), false, "unsupported parity operation"))
	var ok := results.all(func(item: Variant) -> bool: return item is Dictionary and bool(item.get("ok", false)))
	return _response(request_id, ok, results, "")


func _runtime_command_operation(operation: Dictionary) -> Dictionary:
	var command: Variant = operation.get("command")
	if not command is Dictionary or not _command_executor.is_valid(): return _control_result("runtimeCommand", false, "runtime command executor is not bound")
	var result: Variant = await _command_executor.call(command)
	if not result is Dictionary: return _control_result("runtimeCommand", false, "runtime command returned non-object")
	_last_results = [result.duplicate(true)]
	if result.get("ok") == true and _snapshot_builder.is_valid(): result["snapshot"] = _snapshot_builder.call(str(command.get("reason", "runtime-command:%s" % command.get("type", "unknown"))), _last_results)
	return result


func _capture_operation(operation: Dictionary) -> Dictionary:
	var raw_command: Variant = operation.get("command", {})
	if not raw_command is Dictionary:
		return _control_result("captureSnapshot", false, "command must be an object")
	var command: Dictionary = raw_command
	var command_type := str(command.get("type", "")).strip_edges()
	var command_id := str(command.get("id", "captureSnapshot:godot")).strip_edges()
	if command_type != "captureSnapshot":
		return _command_result(command_id, command_type, false, "captureSnapshot operation only accepts captureSnapshot command")
	if not _snapshot_builder.is_valid():
		return _command_result(command_id, command_type, false, "snapshot builder is not bound")
	var reason := str(command.get("reason", "runtime-command:captureSnapshot")).strip_edges()
	if reason.is_empty():
		reason = "runtime-command:captureSnapshot"
	var snapshot: Variant = _snapshot_builder.call(reason, _last_results)
	if not snapshot is Dictionary:
		return _command_result(command_id, command_type, false, "snapshot builder returned a non-object")
	var result := _command_result(command_id, command_type, true, "snapshot captured")
	result["snapshot"] = snapshot
	_last_results = [_command_result(command_id, command_type, true, "snapshot captured")]
	return result


func _response(request_id: String, ok: bool, results: Array, error: String) -> Dictionary:
	return {
		"protocolVersion": PROTOCOL_VERSION,
		"requestId": request_id,
		"runtime": "godot",
		"bootId": _boot_id,
		"ok": ok,
		"results": results,
		"error": error,
	}


func _control_result(type: String, ok: bool, message: String) -> Dictionary:
	return {"type": type, "ok": ok, "message": message}


func _command_result(id: String, type: String, ok: bool, message: String) -> Dictionary:
	return {"id": id, "type": type, "ok": ok, "message": message}


func _user_options() -> Dictionary:
	var result := {}
	for argument in OS.get_cmdline_user_args():
		var text := str(argument)
		if not text.begins_with("--"):
			continue
		var pair := text.trim_prefix("--").split("=", true, 1)
		result[pair[0]] = pair[1] if pair.size() == 2 else true
	return result


func _read_json(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {}
	var value: Variant = JSON.parse_string(file.get_as_text())
	return value if value is Dictionary else {}


func _write_json_atomic(path: String, value: Dictionary) -> bool:
	var temporary := path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		push_error("Godot parity bridge cannot write response: %s" % temporary)
		return false
	file.store_string(JSON.stringify(value, "  ") + "\n")
	file.close()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	var error := DirAccess.rename_absolute(temporary, path)
	if error != OK:
		push_error("Godot parity bridge cannot publish response (%s): %s" % [error, path])
		return false
	return true
