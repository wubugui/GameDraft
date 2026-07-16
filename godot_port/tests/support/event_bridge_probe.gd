class_name EventBridgeProbe
extends RefCounted


static func has_started_session(bridge: RuntimeEventBridge) -> bool:
	return bridge._has_started_session
