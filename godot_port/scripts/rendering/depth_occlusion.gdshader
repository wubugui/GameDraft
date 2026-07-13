shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
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
uniform float debug_mode = 0.0;


void fragment() {
	vec4 color = texture(TEXTURE, UV);
	if (color.a < 0.004) {
		discard;
	}
	vec2 region_size = max(REGION_RECT.zw, vec2(0.000001));
	vec2 local_uv = clamp((UV - REGION_RECT.xy) / region_size, vec2(0.0), vec2(1.0));
	float world_x = entity_foot_x + (local_uv.x - 0.5) * entity_world_size.x * entity_facing;
	float world_y = entity_foot_y - entity_world_size.y + local_uv.y * entity_world_size.y;
	vec2 depth_uv = vec2(world_x / max(scene_size.x, 0.000001), world_y / max(scene_size.y, 0.000001));
	if (depth_uv.x < 0.0 || depth_uv.x > 1.0 || depth_uv.y < 0.0 || depth_uv.y > 1.0) {
		COLOR = color;
	} else {
		vec4 encoded = texture(depth_map, depth_uv);
		float raw_depth = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
		float mapped = mix(raw_depth, 1.0 - raw_depth, step(0.5, depth_invert)) * depth_scale + depth_offset;
		float foot_sy = entity_foot_y * world_to_pixel_y;
		float pixel_sy = world_y * world_to_pixel_y;
		float sprite_depth = floor_a * foot_sy + floor_b + floor_offset + floor_offset_extra + depth_per_sy * (pixel_sy - foot_sy);
		bool occluded = mapped + tolerance < sprite_depth;
		if (debug_mode > 0.5) {
			COLOR = vec4(occluded ? 1.0 : 0.0, 0.0, occluded ? 0.0 : 1.0, 0.7);
		} else {
			if (occluded) {
				if (occlusion_blend_factor < 0.00001) {
					discard;
				}
				color.a *= occlusion_blend_factor;
			}
			COLOR = color;
		}
	}
}
