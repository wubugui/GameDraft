shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D probe_map : filter_linear, repeat_disable;
uniform float depth_enabled = 0.0;
uniform vec2 scene_size = vec2(1.0);
uniform vec2 entity_world_size = vec2(1.0);
uniform float entity_foot_x = 0.0;
uniform float entity_foot_y = 0.0;
uniform float entity_facing = 1.0;
uniform float world_to_pixel_y = 1.0;
uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;
uniform float depth_per_sy = 0.0;
uniform float floor_a = 0.0;
uniform float floor_b = 0.0;
uniform float floor_offset = 0.0;
uniform float floor_offset_extra = 0.0;
uniform float tolerance = 0.0;
uniform float occlusion_blend_factor : hint_range(0.0, 1.0) = 0.28;
uniform vec3 key_color = vec3(1.0);
uniform float key_intensity = 1.0;
uniform vec3 ambient_color = vec3(0.55, 0.6, 0.72);
uniform float ambient_intensity = 1.0;
uniform float tone_strength = 0.0;
uniform float ao_contact = 0.0;
uniform float ao_form = 0.0;
uniform float sample_lift_world = 24.0;
uniform float entity_lighting_enabled = 1.0;
uniform float debug_mode = 0.0;
uniform float pixel_blur_strength = 0.0;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void fragment() {
	vec4 color = texture(TEXTURE, UV);
	if (pixel_blur_strength > 0.0001) {
		vec2 region_min = REGION_RECT.xy + TEXTURE_PIXEL_SIZE * 0.5;
		vec2 region_max = REGION_RECT.xy + REGION_RECT.zw - TEXTURE_PIXEL_SIZE * 0.5;
		vec2 step_uv = TEXTURE_PIXEL_SIZE * pixel_blur_strength;
		vec4 sum = vec4(0.0);
		float weight = 0.0;
		for (int y = -1; y <= 1; y++) {
			for (int x = -1; x <= 1; x++) {
				float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
				vec4 tap = texture(TEXTURE, clamp(UV + vec2(float(x), float(y)) * step_uv, region_min, region_max));
				sum.rgb += tap.rgb * tap.a * w;
				sum.a += tap.a * w;
				weight += w;
			}
		}
		float alpha = sum.a / weight;
		color = vec4(sum.rgb / max(sum.a, 0.000001), alpha);
	}
	if (color.a < 0.004) discard;
	vec2 region_size = max(REGION_RECT.zw, vec2(0.000001));
	vec2 local_uv = clamp((UV - REGION_RECT.xy) / region_size, vec2(0.0), vec2(1.0));
	float world_x = entity_foot_x + (local_uv.x - 0.5) * entity_world_size.x * entity_facing;
	float world_y = entity_foot_y - entity_world_size.y + local_uv.y * entity_world_size.y;
	bool occluded = false;
	if (depth_enabled > 0.5) {
		vec2 duv = vec2(world_x / max(scene_size.x, 0.000001), world_y / max(scene_size.y, 0.000001));
		if (all(greaterThanEqual(duv, vec2(0.0))) && all(lessThanEqual(duv, vec2(1.0)))) {
			vec4 encoded = texture(depth_map, duv);
			float raw = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
			float mapped = mix(raw, 1.0 - raw, step(0.5, depth_invert)) * depth_scale + depth_offset;
			float foot_sy = entity_foot_y * world_to_pixel_y;
			float sprite_depth = floor_a * foot_sy + floor_b + floor_offset + floor_offset_extra + depth_per_sy * (world_y * world_to_pixel_y - foot_sy);
			occluded = mapped + tolerance < sprite_depth;
		}
	}
	if (debug_mode > 0.5) {
		COLOR = vec4(occluded ? 1.0 : 0.0, 0.0, occluded ? 0.0 : 1.0, 0.7);
	} else {
	if (occluded) {
		if (occlusion_blend_factor < 0.00001) discard;
		// Pixi 滤镜纹理是预乘 alpha，原端需 rgb/a 同乘；Godot CanvasItem
		// 这里是直 alpha，标准混合会再乘 a，因此只缩 alpha 才是同一合成结果。
		color.a *= occlusion_blend_factor;
		COLOR = color;
	} else {
	vec3 rgb = color.rgb;
	if (entity_lighting_enabled > 0.5 && tone_strength > 0.0001) {
		vec2 puv = vec2(clamp(entity_foot_x / max(scene_size.x, 0.001), 0.0, 1.0), clamp((entity_foot_y - sample_lift_world) / max(scene_size.y, 0.001), 0.0, 1.0));
		vec3 amb = textureLod(probe_map, puv, 2.0).rgb;
		vec3 net = amb * ambient_intensity + key_color * (key_intensity * 0.5);
		vec3 wb = clamp(net / max(luma(net), 0.04), vec3(0.5), vec3(1.7));
		rgb *= mix(vec3(1.0), wb, tone_strength);
	}
	float contact = entity_lighting_enabled > 0.5 ? ao_contact * smoothstep(0.78, 1.0, local_uv.y) : 0.0;
	rgb *= clamp(1.0 - contact - (entity_lighting_enabled > 0.5 ? ao_form * local_uv.y : 0.0), 0.0, 1.0);
	COLOR = vec4(rgb, color.a);
	}
	}
}
