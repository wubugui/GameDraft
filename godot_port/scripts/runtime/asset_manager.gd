class_name RuntimeAssetManager
extends RefCounted

const ASSET_TYPES := ["json", "texture", "audio", "text", "bitmap", "filter"]
const SAFE_MAX_TEXTURE_SIZE := 2048
const DEFAULT_SCENE_WIDTH := 800
const DEFAULT_SCENE_HEIGHT := 600

var locator: RuntimeResourceLocator
var _buckets: Dictionary = {}
var _scope_refs: Dictionary = {}
var _logical_clock := 0
var _disposed := false
var last_error := ""


func _init(next_locator: RuntimeResourceLocator, limits: Dictionary = {}) -> void:
	locator = next_locator
	var defaults := {
		"json": {"bytes": 32 * 1024 * 1024},
		"texture": {"bytes": 256 * 1024 * 1024},
		"audio": {"bytes": 64 * 1024 * 1024},
		"text": {"bytes": 32 * 1024 * 1024},
		"bitmap": {"bytes": 64 * 1024 * 1024},
		"filter": {"entries": 64},
	}
	for type: String in ASSET_TYPES:
		var limit: Dictionary = defaults[type].duplicate()
		if limits.get(type) is Dictionary:
			limit.merge(limits[type], true)
		_buckets[type] = {
			"entries": {},
			"errors": {},
			"limitBytes": limit.get("bytes"),
			"limitEntries": limit.get("entries"),
			"stats": {"hits": 0, "misses": 0, "loads": 0, "errors": 0, "evictions": 0},
		}


func load_json(path: String) -> Variant:
	var kind := RuntimeResourceLocator.MEDIA if locator.is_media_url(path) else RuntimeResourceLocator.TEXT
	var resolved := _resolve(path, kind)
	return _load_value("json", resolved, func() -> Variant:
		var text: Variant = _read_file(resolved)
		if text == null:
			return null
		return JSON.parse_string(text)
	, func(value: Variant) -> int: return JSON.stringify(value).to_utf8_buffer().size())


func get_json(path: String) -> Variant:
	var kind := RuntimeResourceLocator.MEDIA if locator.is_media_url(path) else RuntimeResourceLocator.TEXT
	return _get_value("json", _resolve(path, kind))


func load_text(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.TEXT)
	return _load_value("text", resolved, func() -> Variant: return _read_file(resolved), func(value: Variant) -> int: return str(value).to_utf8_buffer().size())


func get_text(path: String) -> Variant:
	return _get_value("text", _resolve(path, RuntimeResourceLocator.TEXT))


func load_bitmap(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	return _load_value("bitmap", resolved, func() -> Variant:
		return _load_image_by_signature(resolved)
	, func(value: Variant) -> int:
		var image: Image = value
		return maxi(1, image.get_width()) * maxi(1, image.get_height()) * 4
	)


func get_bitmap(path: String) -> Variant:
	return _get_value("bitmap", _resolve(path, RuntimeResourceLocator.MEDIA))


func load_texture(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	return _load_value("texture", resolved, func() -> Variant:
		var loaded_image: Variant = _load_image_by_signature(resolved)
		if loaded_image == null:
			return null
		var image: Image = loaded_image
		if image.get_width() > SAFE_MAX_TEXTURE_SIZE or image.get_height() > SAFE_MAX_TEXTURE_SIZE:
			last_error = "texture exceeds safe max %spx: %s (%sx%s)" % [SAFE_MAX_TEXTURE_SIZE, resolved, image.get_width(), image.get_height()]
			return null
		return ImageTexture.create_from_image(image)
	, func(value: Variant) -> int:
		var texture: Texture2D = value
		return maxi(1, texture.get_width()) * maxi(1, texture.get_height()) * 4
	)


func get_texture(path: String) -> Variant:
	return _get_value("texture", _resolve(path, RuntimeResourceLocator.MEDIA))


func _load_image_by_signature(resolved: String) -> Variant:
	var file := FileAccess.open(resolved, FileAccess.READ)
	if file == null:
		return null
	var bytes := file.get_buffer(file.get_length())
	file.close()
	var image := Image.new()
	var error := ERR_FILE_UNRECOGNIZED
	if bytes.size() >= 8 and bytes[0] == 0x89 and bytes[1] == 0x50 and bytes[2] == 0x4e and bytes[3] == 0x47:
		error = image.load_png_from_buffer(bytes)
	elif bytes.size() >= 3 and bytes[0] == 0xff and bytes[1] == 0xd8 and bytes[2] == 0xff:
		error = image.load_jpg_from_buffer(bytes)
	elif bytes.size() >= 12 and bytes[0] == 0x52 and bytes[1] == 0x49 and bytes[2] == 0x46 and bytes[3] == 0x46 and bytes[8] == 0x57 and bytes[9] == 0x45 and bytes[10] == 0x42 and bytes[11] == 0x50:
		error = image.load_webp_from_buffer(bytes)
	else:
		error = image.load(resolved)
	if error != OK:
		last_error = "image decode failed (%s): %s" % [error, resolved]
		return null
	return image


func load_audio(path: String, options: Dictionary = {}) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	var loop: bool = options.get("loop", false) == true
	var key := "%s::loop=%s" % [resolved, "1" if loop else "0"]
	return _load_value("audio", key, func() -> Variant:
		var stream := _load_audio_stream(resolved)
		if stream == null:
			return null
		stream = stream.duplicate(true)
		if stream is AudioStreamWAV:
			stream.loop_mode = AudioStreamWAV.LOOP_FORWARD if loop else AudioStreamWAV.LOOP_DISABLED
		elif stream is AudioStreamMP3:
			stream.loop = loop
		elif stream is AudioStreamOggVorbis:
			stream.loop = loop
		return stream
	, func(_value: Variant) -> int:
		var file := FileAccess.open(resolved, FileAccess.READ)
		return maxi(1, file.get_length()) if file != null else 1024 * 1024
	)


func get_audio(path: String, options: Dictionary = {}) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	var key := "%s::loop=%s" % [resolved, "1" if options.get("loop", false) == true else "0"]
	return _get_value("audio", key)


func load_filter(filter_id: String) -> Variant:
	var id := filter_id.strip_edges()
	return _load_value("filter", id, func() -> Variant:
		var definition: Variant = load_json(locator.filter_json_url(id))
		if not definition is Dictionary:
			return null
		var matrix: Variant = definition.get("matrix")
		if not matrix is Array or matrix.size() != 20:
			matrix = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]
		return {"id": id, "matrix": matrix.duplicate(), "alpha": float(definition.get("alpha", 1.0))}
	, func(_value: Variant) -> int: return 1)


func get_filter(filter_id: String) -> Variant:
	return _get_value("filter", filter_id.strip_edges())


func load_ref(ref: Dictionary) -> Variant:
	match str(ref.get("type", "")):
		"json": return load_json(str(ref.get("path", "")))
		"texture": return load_texture(str(ref.get("path", "")))
		"audio": return load_audio(str(ref.get("path", "")), ref.get("options", {}))
		"text": return load_text(str(ref.get("path", "")))
		"bitmap": return load_bitmap(str(ref.get("path", "")))
		"filter": return load_filter(str(ref.get("path", "")))
	return null


func preload_manifest(manifest: Dictionary, options: Dictionary = {}) -> bool:
	var refs := _dedupe_refs(manifest.get("refs", []))
	var scope_id := str(manifest.get("scopeId", ""))
	pin_scope(scope_id, refs)
	var progress: Variant = options.get("onProgress")
	if progress is Callable and progress.is_valid():
		progress.call(0.0, "资源准备" if not refs.is_empty() else "资源准备完成")
	var done := 0
	for ref: Dictionary in refs:
		var value: Variant = load_ref(ref)
		if value == null and options.get("tolerateErrors", false) != true:
			return false
		_pin_loaded_ref(scope_id, ref)
		done += 1
		if progress is Callable and progress.is_valid():
			progress.call(minf(1.0, float(done) / maxf(1.0, refs.size())), str(ref.get("label", "%s: %s" % [ref.get("type"), ref.get("path")])))
	return true


func pin_scope(scope_id: String, refs: Array) -> void:
	release_scope(scope_id)
	var deduped := _dedupe_refs(refs)
	_scope_refs[scope_id] = deduped
	for ref: Dictionary in deduped:
		var bucket: Dictionary = _buckets[ref.type]
		var key := _key_for_ref(ref)
		if bucket.entries.has(key):
			bucket.entries[key].pins[scope_id] = true


func release_scope(scope_id: String) -> void:
	var refs: Variant = _scope_refs.get(scope_id)
	if not refs is Array:
		return
	for ref: Dictionary in refs:
		var bucket: Dictionary = _buckets[ref.type]
		var key := _key_for_ref(ref)
		if bucket.entries.has(key):
			bucket.entries[key].pins.erase(scope_id)
	_scope_refs.erase(scope_id)
	for type: String in ASSET_TYPES:
		_evict(type)


func get_stats() -> Dictionary:
	var result := {}
	for type: String in ASSET_TYPES:
		var bucket: Dictionary = _buckets[type]
		var pinned := 0
		var bytes := 0
		for entry: Dictionary in bucket.entries.values():
			bytes += int(entry.bytes)
			if not entry.pins.is_empty():
				pinned += 1
		var stats: Dictionary = bucket.stats.duplicate()
		stats.merge({"entries": bucket.entries.size(), "bytes": bytes, "pinned": pinned}, true)
		result[type] = stats
	return result


func clear_cache(type: String = "") -> void:
	var types := [type] if ASSET_TYPES.has(type) else ASSET_TYPES
	for current: String in types:
		_buckets[current].entries.clear()
		_buckets[current].errors.clear()
	if type.is_empty():
		_scope_refs.clear()


func dispose() -> void:
	_disposed = true
	clear_cache()


func resolve_scene_asset_path(scene_id: String, image_path: String) -> String:
	return image_path if image_path.is_empty() else locator.scene_runtime_asset_url(scene_id, image_path)


func load_scene_data(scene_id: String) -> Dictionary:
	var cached: Variant = load_json(locator.scene_json_url(scene_id))
	if not cached is Dictionary:
		return {}
	var raw: Dictionary = cached.duplicate(true)
	var backgrounds: Variant = raw.get("backgrounds")
	if backgrounds is Array and not backgrounds.is_empty():
		if str(backgrounds[0].get("image", "")) != "background.png":
			last_error = "scene %s primary background must be background.png" % scene_id
			return {}
		for layer: Variant in backgrounds:
			if layer is Dictionary:
				layer.image = resolve_scene_asset_path(scene_id, str(layer.get("image", "")))
	var width := float(raw.get("worldWidth", 0.0))
	var height := float(raw.get("worldHeight", 0.0))
	if width > 0.0 and height > 0.0:
		return raw
	if backgrounds is Array and not backgrounds.is_empty():
		var texture: Variant = load_texture(str(backgrounds[0].get("image", "")))
		if texture is Texture2D and texture.get_width() > 0:
			var ratio := float(texture.get_height()) / float(texture.get_width())
			if width > 0.0:
				height = round(width * ratio)
			elif height > 0.0:
				width = round(height / ratio)
			else:
				width = texture.get_width()
				height = texture.get_height()
	raw.worldWidth = width if width > 0.0 else float(raw.get("worldWidth", DEFAULT_SCENE_WIDTH))
	raw.worldHeight = height if height > 0.0 else float(raw.get("worldHeight", DEFAULT_SCENE_HEIGHT))
	return raw


func _resolve(path: String, kind: String) -> String:
	var resolved := locator.resolve_url(path, kind)
	if resolved.is_empty():
		last_error = "unresolvable %s asset path: %s" % [kind, path]
	return resolved


func _load_value(type: String, key: String, loader: Callable, size_of: Callable) -> Variant:
	if _disposed or key.is_empty():
		last_error = "AssetManager is disposed" if _disposed else last_error
		return null
	var bucket: Dictionary = _buckets[type]
	if bucket.entries.has(key):
		bucket.stats.hits += 1
		return _touch(bucket.entries[key])
	bucket.stats.misses += 1
	var value: Variant = loader.call()
	if value == null:
		bucket.stats.errors += 1
		bucket.errors[key] = last_error if not last_error.is_empty() else "load failed"
		return null
	bucket.errors.erase(key)
	bucket.stats.loads += 1
	var entry := {"key": key, "type": type, "value": value, "bytes": maxi(1, int(size_of.call(value))), "lastUsed": 0, "pins": _scopes_for_key(type, key)}
	_touch(entry)
	bucket.entries[key] = entry
	_evict(type)
	return value


func _get_value(type: String, key: String) -> Variant:
	var bucket: Dictionary = _buckets[type]
	if key.is_empty() or not bucket.entries.has(key):
		bucket.stats.misses += 1
		return null
	bucket.stats.hits += 1
	return _touch(bucket.entries[key])


func _touch(entry: Dictionary) -> Variant:
	_logical_clock += 1
	entry.lastUsed = _logical_clock
	return entry.value


func _evict(type: String) -> void:
	var bucket: Dictionary = _buckets[type]
	while _over_limit(bucket):
		var victim_key := ""
		var victim_clock := 9223372036854775807
		for key: String in bucket.entries:
			var entry: Dictionary = bucket.entries[key]
			if not entry.pins.is_empty():
				continue
			if int(entry.lastUsed) < victim_clock:
				victim_key = key
				victim_clock = int(entry.lastUsed)
		if victim_key.is_empty():
			break
		bucket.entries.erase(victim_key)
		bucket.stats.evictions += 1


func _over_limit(bucket: Dictionary) -> bool:
	if bucket.limitEntries != null and bucket.entries.size() > int(bucket.limitEntries):
		return true
	if bucket.limitBytes != null:
		var total := 0
		for entry: Dictionary in bucket.entries.values():
			total += int(entry.bytes)
		return total > int(bucket.limitBytes)
	return false


func _key_for_ref(ref: Dictionary) -> String:
	if str(ref.get("type", "")) == "filter":
		return str(ref.get("path", "")).strip_edges()
	var kind := RuntimeResourceLocator.TEXT if ref.type in ["json", "text"] else RuntimeResourceLocator.MEDIA
	var resolved := _resolve(str(ref.get("path", "")), kind)
	if ref.type == "audio":
		return "%s::loop=%s" % [resolved, "1" if ref.get("options", {}).get("loop", false) == true else "0"]
	return resolved


func _dedupe_refs(refs: Array) -> Array:
	var seen := {}
	var result: Array = []
	for raw_ref: Variant in refs:
		if not raw_ref is Dictionary or str(raw_ref.get("path", "")).strip_edges().is_empty() or not ASSET_TYPES.has(str(raw_ref.get("type", ""))):
			continue
		var ref: Dictionary = raw_ref.duplicate(true)
		var key := "%s:%s" % [ref.type, _key_for_ref(ref)]
		if seen.has(key):
			continue
		seen[key] = true
		result.push_back(ref)
	return result


func _pin_loaded_ref(scope_id: String, ref: Dictionary) -> void:
	var bucket: Dictionary = _buckets[ref.type]
	var key := _key_for_ref(ref)
	if bucket.entries.has(key):
		bucket.entries[key].pins[scope_id] = true


func _scopes_for_key(type: String, key: String) -> Dictionary:
	var result := {}
	for scope_id: String in _scope_refs:
		for ref: Dictionary in _scope_refs[scope_id]:
			if ref.type == type and _key_for_ref(ref) == key:
				result[scope_id] = true
	return result


func _read_file(path: String) -> Variant:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		last_error = "cannot open asset: %s" % path
		return null
	return file.get_as_text()


func _load_audio_stream(path: String) -> AudioStream:
	if path.begins_with("res://"):
		var resource := ResourceLoader.load(path)
		return resource if resource is AudioStream else null
	match path.get_extension().to_lower():
		"wav":
			var compatible := _load_wave_pcm_compatible(path)
			return compatible if compatible != null else AudioStreamWAV.load_from_file(path)
		"mp3": return AudioStreamMP3.load_from_file(path)
		"ogg": return AudioStreamOggVorbis.load_from_file(path)
	last_error = "unsupported audio format: %s" % path
	return null


# Godot 4's WAV loader rejects WAVE_FORMAT_EXTENSIBLE 24-bit PCM and also seeks
# one byte past EOF for legal odd-sized terminal PCM8 data chunks. Both shapes
# exist in the shared library. Parse ordinary PCM here without rewriting assets
# used by the TypeScript shell; unsupported WAV codecs still fall through to
# Godot's native loader.
func _load_wave_pcm_compatible(path: String) -> AudioStreamWAV:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return null
	var bytes := file.get_buffer(file.get_length())
	if bytes.size() < 44 or _ascii4(bytes, 0) != "RIFF" or _ascii4(bytes, 8) != "WAVE":
		return null
	var format_offset := -1
	var format_size := 0
	var data_offset := -1
	var data_size := 0
	var cursor := 12
	while cursor + 8 <= bytes.size():
		var chunk_id := _ascii4(bytes, cursor)
		var chunk_size := _u32_le(bytes, cursor + 4)
		var payload := cursor + 8
		if payload + chunk_size > bytes.size():
			break
		if chunk_id == "fmt ": format_offset = payload; format_size = chunk_size
		elif chunk_id == "data": data_offset = payload; data_size = chunk_size
		cursor = payload + chunk_size + (chunk_size & 1)
	if format_offset < 0 or format_size < 16 or data_offset < 0:
		return null
	var format_tag := _u16_le(bytes, format_offset)
	var channels := _u16_le(bytes, format_offset + 2)
	var sample_rate := _u32_le(bytes, format_offset + 4)
	var block_align := _u16_le(bytes, format_offset + 12)
	var bits_per_sample := _u16_le(bytes, format_offset + 14)
	var pcm_tag := format_tag
	if format_tag == 0xfffe and format_size >= 26:
		pcm_tag = _u16_le(bytes, format_offset + 24)
	if pcm_tag != 1 or bits_per_sample not in [8, 16, 24] or channels not in [1, 2] or block_align != channels * (bits_per_sample / 8):
		return null
	var source_size := mini(data_size, bytes.size() - data_offset)
	var frame_count := source_size / block_align
	var stream := AudioStreamWAV.new()
	stream.mix_rate = sample_rate
	stream.stereo = channels == 2
	if bits_per_sample == 8:
		stream.format = AudioStreamWAV.FORMAT_8_BITS
		stream.data = bytes.slice(data_offset, data_offset + frame_count * block_align)
		return stream
	if bits_per_sample == 16:
		stream.format = AudioStreamWAV.FORMAT_16_BITS
		stream.data = bytes.slice(data_offset, data_offset + frame_count * block_align)
		return stream
	# Reinterpret each 24-bit sample as one RGB8 pixel after shifting away its
	# low byte, then use Image's native C++ channel conversion to retain the
	# middle/high bytes as RG8. This avoids millions of interpreted GDScript
	# iterations on the 45 MB river ambience.
	var sample_count := frame_count * channels
	var image_width := mini(16384, sample_count)
	var image_height := int(ceil(float(sample_count) / float(image_width)))
	var padded_samples := image_width * image_height
	var shifted := bytes.slice(data_offset + 1, data_offset + frame_count * block_align)
	shifted.resize(padded_samples * 3)
	var carrier := Image.create_from_data(image_width, image_height, false, Image.FORMAT_RGB8, shifted)
	carrier.convert(Image.FORMAT_RG8)
	var converted := carrier.get_data().slice(0, sample_count * 2)
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.data = converted
	return stream


static func _ascii4(bytes: PackedByteArray, offset: int) -> String:
	if offset < 0 or offset + 4 > bytes.size():
		return ""
	return bytes.slice(offset, offset + 4).get_string_from_ascii()


static func _u16_le(bytes: PackedByteArray, offset: int) -> int:
	return int(bytes[offset]) | (int(bytes[offset + 1]) << 8)


static func _u32_le(bytes: PackedByteArray, offset: int) -> int:
	return int(bytes[offset]) | (int(bytes[offset + 1]) << 8) | (int(bytes[offset + 2]) << 16) | (int(bytes[offset + 3]) << 24)
