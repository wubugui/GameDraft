shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D probe_map : filter_linear, repeat_disable;
uniform float canvas_group_target = 0.0;

uniform vec2 scene_size = vec2(0.0);
uniform float projection_scale = 1.0;
uniform float world_to_pixel_x = 1.0;
uniform float world_to_pixel_y = 1.0;
uniform vec2 world_container_pos = vec2(0.0);
uniform float entity_foot_world_x = 0.0;
uniform float entity_foot_world_y = 0.0;
uniform float sample_lift_world = 0.0;

uniform float depth_enabled = 0.0;
uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;
uniform float depth_per_sy = 0.0;
uniform float floor_a = 0.0;
uniform float floor_b = 0.0;
uniform float floor_offset = 0.0;
uniform float floor_offset_extra = 0.0;
uniform float tolerance = 0.0;
uniform float occlusion_blend_factor : hint_range(0.0, 1.0) = 0.0;
uniform float debug_mode = 0.0;

uniform vec3 key_color = vec3(1.0);
uniform float key_intensity = 1.0;
uniform vec3 ambient_color = vec3(1.0);
uniform float ambient_intensity = 1.0;
uniform float tone_strength = 0.0;
uniform float ao_contact = 0.0;
uniform float ao_form = 0.0;

// Engine adapter for SpriteEntity/Hotspot's inner Pixi BlurFilter. Godot has a
// single CanvasItem material slot, so the blur pass executes first in this same
// shader and the translated EntityLightingFilter logic consumes its result.
uniform float pixel_blur_strength = 0.0;

float luma(vec3 color) { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }

void fragment() {
	vec4 color = texture(TEXTURE, UV);
	if (canvas_group_target > 0.5) {
		color = COLOR * textureLod(screen_texture, SCREEN_UV, 0.0);
	}
	if (canvas_group_target < 0.5 && pixel_blur_strength > 0.0001) {
		vec2 region_min = REGION_RECT.xy + TEXTURE_PIXEL_SIZE * 0.5;
		vec2 region_max = REGION_RECT.xy + REGION_RECT.zw - TEXTURE_PIXEL_SIZE * 0.5;
		vec2 step_uv = TEXTURE_PIXEL_SIZE * pixel_blur_strength;
		vec4 sum = vec4(0.0);
		float weight = 0.0;
		for (int y = -1; y <= 1; y++) {
			for (int x = -1; x <= 1; x++) {
				float tap_weight = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
				vec4 tap = texture(TEXTURE, clamp(UV + vec2(float(x), float(y)) * step_uv, region_min, region_max));
				sum.rgb += tap.rgb * tap.a * tap_weight;
				sum.a += tap.a * tap_weight;
				weight += tap_weight;
			}
		}
		float alpha = sum.a / weight;
		color = vec4(sum.rgb / max(sum.a, 0.000001), alpha);
	}

	if (color.a < 0.004) {
		discard;
	}

	float scale_value = max(projection_scale, 0.000001);
	float world_x = (FRAGCOORD.x - world_container_pos.x) / scale_value;
	float world_y = (FRAGCOORD.y - world_container_pos.y) / scale_value;
	bool occluded = false;
	if (depth_enabled > 0.5) {
		vec2 depth_uv = vec2(world_x / scene_size.x, world_y / scene_size.y);
		if (depth_uv.x >= 0.0 && depth_uv.x <= 1.0 && depth_uv.y >= 0.0 && depth_uv.y <= 1.0) {
			vec4 depth_sample = texture(depth_map, depth_uv);
			float raw_depth = (depth_sample.r * 255.0 * 256.0 + depth_sample.g * 255.0) / 65535.0;
			float mapped_depth = (depth_invert > 0.5 ? 1.0 - raw_depth : raw_depth) * depth_scale + depth_offset;
			float foot_sy = entity_foot_world_y * world_to_pixel_y;
			float pixel_sy = world_y * world_to_pixel_y;
			float base_depth = floor_a * foot_sy + floor_b + floor_offset + floor_offset_extra;
			float sprite_depth = base_depth + depth_per_sy * (pixel_sy - foot_sy);
			occluded = mapped_depth + tolerance < sprite_depth;
		}
	}

	if (debug_mode > 0.5) {
		COLOR = vec4(occluded ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), 0.7);
	} else if (occluded) {
		if (occlusion_blend_factor < 0.00001) {
			discard;
		}
		// Pixi's filter target is premultiplied. Godot uses straight-alpha canvas
		// blending, so reducing alpha alone gives the same final contribution.
		color.a *= occlusion_blend_factor;
		COLOR = color;
	} else {
		vec3 rgb = color.rgb;
		if (tone_strength > 0.0001) {
			float sample_u = clamp(entity_foot_world_x / max(scene_size.x, 0.001), 0.0, 1.0);
			float sample_v = clamp((entity_foot_world_y - sample_lift_world) / max(scene_size.y, 0.001), 0.0, 1.0);
			vec3 irradiance = texture(probe_map, vec2(sample_u, sample_v)).rgb;
			vec3 net_light = irradiance * ambient_intensity + key_color * (key_intensity * 0.5);
			vec3 white_balance = clamp(net_light / max(luma(net_light), 0.04), vec3(0.5), vec3(1.7));
			rgb *= mix(vec3(1.0), white_balance, tone_strength);
		}
		vec2 region_size = max(REGION_RECT.zw, vec2(0.000001));
		float local_y = clamp((UV.y - REGION_RECT.y) / region_size.y, 0.0, 1.0);
		float contact = ao_contact * smoothstep(0.78, 1.0, local_y);
		float form = ao_form * local_y;
		rgb *= clamp(1.0 - contact - form, 0.0, 1.0);
		rgb = min(rgb, vec3(1.0));
		COLOR = vec4(rgb, color.a);
	}
}
