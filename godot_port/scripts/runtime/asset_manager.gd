class_name RuntimeAssetManager
extends RefCounted

const RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")

const DEFAULT_SCENE_WIDTH := 800
const DEFAULT_SCENE_HEIGHT := 600
const MB := 1024 * 1024
const SAFE_MAX_TEXTURE_SIZE := 2048
const ASSET_TYPES := ["json", "texture", "audio", "text", "bitmap", "filter"]
const DEFAULT_LIMITS := {
	"json": {"bytes": 32 * MB},
	"texture": {"bytes": 256 * MB},
	"audio": {"bytes": 64 * MB},
	"text": {"bytes": 32 * MB},
	"bitmap": {"bytes": 64 * MB},
	"filter": {"entries": 64},
}

var _buckets: Dictionary = {}
var _logical_clock := 0
var _scope_refs: Dictionary = {}
var _disposed := false
var _verbose_stage_log := false

# Engine adapter state. TypeScript imports browser URL/error primitives; Godot
# retains their filesystem/error counterparts behind this boundary.
var _locator: RuntimeResourceLocator
var _last_error := ""


static func _create_bucket(type: String) -> Dictionary:
	var limits: Dictionary = DEFAULT_LIMITS[type]
	return {
		"entries": {},
		"inflight": {},
		"errors": {},
		"limitBytes": limits.get("bytes"),
		"limitEntries": limits.get("entries"),
		"stats": {"hits": 0, "misses": 0, "loads": 0, "errors": 0, "evictions": 0},
	}


static func _text_bytes(text: String) -> int:
	return text.to_utf8_buffer().size()


static func _json_bytes(value: Variant) -> int:
	return JSON.stringify(value).to_utf8_buffer().size()


static func _texture_bytes(texture: Texture2D) -> int:
	return maxi(1, texture.get_width()) * maxi(1, texture.get_height()) * 4


func _assert_safe_texture_size(texture: Texture2D, key: String) -> bool:
	if texture.get_width() <= SAFE_MAX_TEXTURE_SIZE and texture.get_height() <= SAFE_MAX_TEXTURE_SIZE:
		return true
	_last_error = "texture exceeds safe max %spx: %s (%sx%s)" % [SAFE_MAX_TEXTURE_SIZE, key, texture.get_width(), texture.get_height()]
	return false


static func _bitmap_bytes(bitmap: Image) -> int:
	return maxi(1, bitmap.get_width()) * maxi(1, bitmap.get_height()) * 4


static func _audio_bytes(stream: AudioStream) -> int:
	var duration := stream.get_length()
	if not is_finite(duration) or duration <= 0.0:
		return MB
	return maxi(1, roundi(duration * 44100.0 * 2.0 * 2.0))


func _init(limits: Dictionary = {}, resource_locator: RuntimeResourceLocator = null) -> void:
	_locator = resource_locator if resource_locator != null else RuntimeResourceLocator.get_default()
	for type: String in ASSET_TYPES:
		_buckets[type] = _create_bucket(type)
	for raw_type: Variant in limits:
		var type := str(raw_type)
		var limit: Variant = limits[raw_type]
		if not ASSET_TYPES.has(type) or not limit is Dictionary:
			continue
		if limit.get("bytes") != null:
			_buckets[type].limitBytes = limit.bytes
		if limit.get("entries") != null:
			_buckets[type].limitEntries = limit.entries


func _touch(bucket: Dictionary, entry: Dictionary) -> Variant:
	_logical_clock += 1
	entry.lastUsed = _logical_clock
	bucket.entries.erase(entry.key)
	bucket.entries[entry.key] = entry
	return entry.value


func _get_from_bucket(type: String, key: String) -> Variant:
	var bucket: Dictionary = _buckets[type]
	var entry: Variant = bucket.entries.get(key)
	if not entry is Dictionary:
		bucket.stats.misses += 1
		return null
	bucket.stats.hits += 1
	return _touch(bucket, entry)


func _load_into_bucket(type: String, key: String, loader: Callable, size_of: Callable) -> Variant:
	var bucket: Dictionary = _buckets[type]
	var cached_entry: Variant = bucket.entries.get(key)
	if cached_entry is Dictionary:
		bucket.stats.hits += 1
		return _touch(bucket, cached_entry)
	bucket.stats.misses += 1

	# Local Godot reads are synchronous, so the source Promise inflight map has no
	# live interval. The bucket retains the field, while this adapter executes once.
	_last_error = ""
	var value: Variant = loader.call()
	if value == null:
		var error: Variant = _last_error if not _last_error.is_empty() else "load failed"
		bucket.errors[key] = error
		bucket.stats.errors += 1
		RuntimeDevErrorOverlay.report_dev_error("[%s] 加载失败: %s\n%s" % [type, key, RuntimeDevErrorOverlay.describe_error(error)])
		return null
	if _disposed:
		_dispose_value(type, value)
		return value
	bucket.errors.erase(key)
	bucket.stats.loads += 1
	var existing: Variant = bucket.entries.get(key)
	var pins: Dictionary = existing.pins if existing is Dictionary else _scopes_for_key(type, key)
	var entry := {
		"key": key,
		"type": type,
		"value": value,
		"bytes": maxi(1, int(size_of.call(value))),
		"lastUsed": _logical_clock + 1,
		"pins": pins,
	}
	_logical_clock += 1
	bucket.entries[key] = entry
	_evict(type)
	return value


func _evict(type: String) -> void:
	var bucket: Dictionary = _buckets[type]
	while _over_limit(bucket):
		var victim: Variant = null
		for entry: Dictionary in bucket.entries.values():
			if not entry.pins.is_empty():
				continue
			# AudioStream resources do not own playback in Godot; AudioStreamPlayer
			# keeps its own reference, so cache eviction cannot cut active sound.
			if victim == null or int(entry.lastUsed) < int(victim.lastUsed):
				victim = entry
		if not victim is Dictionary:
			break
		_dispose_entry(victim)
		bucket.entries.erase(victim.key)
		bucket.stats.evictions += 1


func _bucket_bytes(bucket: Dictionary) -> int:
	var total := 0
	for entry: Dictionary in bucket.entries.values():
		total += int(entry.bytes)
	return total


func _dispose_entry(entry: Dictionary) -> void:
	_dispose_value(str(entry.type), entry.value)


func _dispose_value(_type: String, _value: Variant) -> void:
	# Pixi/Howler/ImageBitmap require explicit unload/close. Godot resources are
	# reference-counted; removing the cache entry is the corresponding release.
	return


func _key_for_ref(ref: Dictionary) -> String:
	if str(ref.type) == "filter":
		return str(ref.path).strip_edges()
	var kind := RuntimeResourceLocator.TEXT if str(ref.type) in ["json", "text"] else RuntimeResourceLocator.MEDIA
	var resolved := _resolve(str(ref.path), kind)
	if str(ref.type) == "audio":
		return "%s::loop=%s" % [resolved, "1" if ref.get("options", {}).get("loop") == true else "0"]
	return resolved


func load_texture(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	return _load_into_bucket("texture", resolved, func() -> Variant:
		var image: Variant = _load_image_by_signature(resolved)
		if not image is Image:
			return null
		var texture := ImageTexture.create_from_image(image)
		return texture if _assert_safe_texture_size(texture, resolved) else null
	, func(value: Variant) -> int: return _texture_bytes(value))


func get_texture(path: String) -> Variant:
	return _get_from_bucket("texture", _resolve(path, RuntimeResourceLocator.MEDIA))


func load_json(path: String) -> Variant:
	var kind := RuntimeResourceLocator.MEDIA if _locator.is_media_url(path) else RuntimeResourceLocator.TEXT
	var resolved := _resolve(path, kind)
	return _load_into_bucket("json", resolved, func() -> Variant:
		var text: Variant = _read_file(resolved)
		if not text is String:
			return null
		var parser := JSON.new()
		if parser.parse(text) != OK:
			_last_error = "JSON parse failed at line %s: %s (%s)" % [parser.get_error_line(), parser.get_error_message(), resolved]
			return null
		return parser.data
	, func(value: Variant) -> int: return _json_bytes(value))


func get_json(path: String) -> Variant:
	var kind := RuntimeResourceLocator.MEDIA if _locator.is_media_url(path) else RuntimeResourceLocator.TEXT
	return _get_from_bucket("json", _resolve(path, kind))


func load_text(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.TEXT)
	return _load_into_bucket("text", resolved, func() -> Variant: return _read_file(resolved), func(value: Variant) -> int: return _text_bytes(str(value)))


func get_text(path: String) -> Variant:
	return _get_from_bucket("text", _resolve(path, RuntimeResourceLocator.TEXT))


func load_bitmap(path: String) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	return _load_into_bucket("bitmap", resolved, func() -> Variant: return _load_image_by_signature(resolved), func(value: Variant) -> int: return _bitmap_bytes(value))


func get_bitmap(path: String) -> Variant:
	return _get_from_bucket("bitmap", _resolve(path, RuntimeResourceLocator.MEDIA))


func load_audio(path: String, options: Dictionary = {}) -> Variant:
	var loop: bool = options.get("loop") == true
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	var key := "%s::loop=%s" % [resolved, "1" if loop else "0"]
	return _load_into_bucket("audio", key, func() -> Variant:
		var loaded: Variant = _load_audio_stream(resolved)
		if not loaded is AudioStream:
			return null
		var stream: AudioStream = loaded.duplicate(true)
		if stream is AudioStreamWAV:
			stream.loop_mode = AudioStreamWAV.LOOP_FORWARD if loop else AudioStreamWAV.LOOP_DISABLED
		elif stream is AudioStreamMP3:
			stream.loop = loop
		elif stream is AudioStreamOggVorbis:
			stream.loop = loop
		return stream
	, func(value: Variant) -> int: return _audio_bytes(value))


func get_audio(path: String, options: Dictionary = {}) -> Variant:
	var resolved := _resolve(path, RuntimeResourceLocator.MEDIA)
	var key := "%s::loop=%s" % [resolved, "1" if options.get("loop") == true else "0"]
	return _get_from_bucket("audio", key)


func load_filter(filter_id: String) -> Variant:
	var id := filter_id.strip_edges()
	return _load_into_bucket("filter", id, func() -> Variant:
		var definition: Variant = load_json(_locator.filter_json_url(id))
		if not definition is Dictionary:
			return null
		return RuntimeFilterLoaderScript.create_filter_from_def(definition)
	, func(_value: Variant) -> int: return 1)


func get_filter(filter_id: String) -> Variant:
	return _get_from_bucket("filter", filter_id.strip_edges())


func preload_manifest(manifest: Dictionary, options: Dictionary = {}) -> bool:
	var refs := _dedupe_refs(manifest.refs)
	var scope_id := str(manifest.scopeId)
	pin_scope(scope_id, refs)
	var total := maxi(1, refs.size())
	var done := 0
	var progress: Variant = options.get("onProgress")
	if progress is Callable and progress.is_valid():
		progress.call(0.0, "资源准备" if not refs.is_empty() else "资源准备完成")
	var failed := false
	for ref: Dictionary in refs:
		var label := str(ref.get("label", "%s: %s" % [ref.type, ref.path]))
		var value: Variant = load_ref(ref)
		if value != null:
			_pin_loaded_ref(scope_id, ref)
		elif options.get("tolerateErrors") != true:
			failed = true
		done += 1
		if progress is Callable and progress.is_valid():
			progress.call(minf(1.0, float(done) / float(total)), label)
	return not failed


func load_ref(ref: Dictionary) -> Variant:
	match str(ref.type):
		"json": return load_json(str(ref.path))
		"texture": return load_texture(str(ref.path))
		"audio": return load_audio(str(ref.path), ref.get("options", {}))
		"text": return load_text(str(ref.path))
		"bitmap": return load_bitmap(str(ref.path))
		"filter": return load_filter(str(ref.path))
	return null


func pin_scope(scope_id: String, refs: Array) -> void:
	release_scope(scope_id)
	var deduped := _dedupe_refs(refs)
	_scope_refs[scope_id] = deduped
	for ref: Dictionary in deduped:
		var bucket: Dictionary = _buckets[ref.type]
		var entry: Variant = bucket.entries.get(_key_for_ref(ref))
		if entry is Dictionary:
			entry.pins[scope_id] = true


func _pin_loaded_ref(scope_id: String, ref: Dictionary) -> void:
	var bucket: Dictionary = _buckets[ref.type]
	var entry: Variant = bucket.entries.get(_key_for_ref(ref))
	if entry is Dictionary:
		entry.pins[scope_id] = true


func _scopes_for_key(type: String, key: String) -> Dictionary:
	var pins := {}
	for scope_id: String in _scope_refs:
		for ref: Dictionary in _scope_refs[scope_id]:
			if str(ref.type) == type and _key_for_ref(ref) == key:
				pins[scope_id] = true
				break
	return pins


func release_scope(scope_id: String) -> void:
	var refs: Variant = _scope_refs.get(scope_id)
	if not refs is Array:
		return
	for ref: Dictionary in refs:
		var bucket: Dictionary = _buckets[ref.type]
		var entry: Variant = bucket.entries.get(_key_for_ref(ref))
		if entry is Dictionary:
			entry.pins.erase(scope_id)
	_scope_refs.erase(scope_id)
	for type: String in ASSET_TYPES:
		_evict(type)


func get_stats() -> Dictionary:
	var result := {}
	for type: String in ASSET_TYPES:
		var bucket: Dictionary = _buckets[type]
		var pinned := 0
		for entry: Dictionary in bucket.entries.values():
			if not entry.pins.is_empty():
				pinned += 1
		var stats: Dictionary = bucket.stats.duplicate()
		stats.merge({"entries": bucket.entries.size(), "bytes": _bucket_bytes(bucket), "pinned": pinned}, true)
		result[type] = stats
	return result


func clear_cache(type: String = "") -> void:
	var types: Array = [type] if not type.is_empty() else ASSET_TYPES
	for current: String in types:
		var bucket: Dictionary = _buckets[current]
		for entry: Dictionary in bucket.entries.values():
			_dispose_entry(entry)
		bucket.entries.clear()
		bucket.inflight.clear()
		bucket.errors.clear()
	if type.is_empty():
		_scope_refs.clear()


func dispose() -> void:
	_disposed = true
	clear_cache()


func resolve_scene_asset_path(scene_id: String, image_path: String) -> String:
	if image_path.is_empty():
		return image_path
	return _locator.scene_runtime_asset_url(scene_id, image_path)


func load_scene_data(scene_id: String) -> Dictionary:
	var cached: Variant = load_json(_locator.scene_json_url(scene_id))
	if not cached is Dictionary:
		return {}
	var raw: Dictionary = cached.duplicate(true)
	var backgrounds: Variant = raw.get("backgrounds")
	if backgrounds is Array and not backgrounds.is_empty():
		var primary_image: Variant = backgrounds[0].get("image")
		if primary_image != "background.png":
			_last_error = "场景 \"%s\" 的背景图文件名必须是 background.png，实际为 \"%s\"。请在编辑器中重新导入背景图。" % [scene_id, primary_image]
			return {}
		for layer: Dictionary in backgrounds:
			layer.image = resolve_scene_asset_path(scene_id, str(layer.image))
	var world_width: Variant = raw.get("worldWidth")
	var world_height: Variant = raw.get("worldHeight")
	if (world_width is int or world_width is float) and (world_height is int or world_height is float) and float(world_width) > 0.0 and float(world_height) > 0.0:
		return raw
	if backgrounds is Array and not backgrounds.is_empty():
		var texture: Variant = load_texture(str(backgrounds[0].image))
		if texture is Texture2D and texture.get_width() > 0:
			var texture_width: int = texture.get_width()
			var texture_height: int = texture.get_height()
			var ratio := float(texture_height) / float(texture_width)
			if (world_width is int or world_width is float) and float(world_width) > 0.0:
				raw.worldWidth = world_width
				raw.worldHeight = roundi(float(world_width) * ratio)
			elif (world_height is int or world_height is float) and float(world_height) > 0.0:
				raw.worldWidth = roundi(float(world_height) / ratio)
				raw.worldHeight = world_height
			else:
				raw.worldWidth = texture_width
				raw.worldHeight = texture_height
			return raw
	raw.worldWidth = world_width if world_width != null else DEFAULT_SCENE_WIDTH
	raw.worldHeight = world_height if world_height != null else DEFAULT_SCENE_HEIGHT
	return raw


func _dedupe_refs(refs: Array) -> Array:
	var seen := {}
	var result: Array = []
	for ref: Dictionary in refs:
		if str(ref.get("path", "")).strip_edges().is_empty():
			continue
		var key := "%s:%s" % [ref.type, _key_for_ref(ref)]
		if seen.has(key):
			continue
		seen[key] = true
		result.push_back(ref)
	return result


# GDScript has no exception channel. This read-only adapter lets source catch
# sites preserve their diagnostic payload without exposing mutable cache state.
func get_last_error() -> String:
	return _last_error


func _over_limit(bucket: Dictionary) -> bool:
	if bucket.limitEntries != null and bucket.entries.size() > int(bucket.limitEntries):
		return true
	if bucket.limitBytes != null and _bucket_bytes(bucket) > int(bucket.limitBytes):
		return true
	return false


func _resolve(path: String, kind: String) -> String:
	var resolved := _locator.resolve_url(path, kind)
	if resolved.is_empty():
		_last_error = "unresolvable %s asset path: %s" % [kind, path]
	return resolved


func _read_file(path: String) -> Variant:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		_last_error = "cannot open asset: %s" % path
		return null
	var text := file.get_as_text()
	file.close()
	return text


func _load_image_by_signature(resolved: String) -> Variant:
	var file := FileAccess.open(resolved, FileAccess.READ)
	if file == null:
		_last_error = "cannot open asset: %s" % resolved
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
		_last_error = "image decode failed (%s): %s" % [error, resolved]
		return null
	return image


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
	_last_error = "unsupported audio format: %s" % path
	return null


func _load_wave_pcm_compatible(path: String) -> AudioStreamWAV:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return null
	var bytes := file.get_buffer(file.get_length())
	file.close()
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
		if chunk_id == "fmt ":
			format_offset = payload
			format_size = chunk_size
		elif chunk_id == "data":
			data_offset = payload
			data_size = chunk_size
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
