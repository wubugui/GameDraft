shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D collision_map : filter_nearest, repeat_disable;

uniform float mode = 0.0;
uniform vec2 texture_size = vec2(1.0);
uniform vec2 world_container_pos = vec2(0.0);
uniform vec2 scene_size = vec2(1.0);

uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;

uniform float matrix_ppu = 1.0;
uniform float matrix_cx = 0.0;
uniform float matrix_cy = 0.0;
uniform float matrix_r00 = 1.0;
uniform float matrix_r01 = 0.0;
uniform float matrix_r02 = 0.0;
uniform float matrix_r20 = 0.0;
uniform float matrix_r21 = 0.0;
uniform float matrix_r22 = 1.0;
uniform float floor_a = 0.0;
uniform float floor_b = 0.0;

uniform float collision_x_min = 0.0;
uniform float collision_z_min = 0.0;
uniform float collision_cell_size = 1.0;
uniform float collision_grid_width = 0.0;
uniform float collision_grid_height = 0.0;

uniform vec2 debug_depth_range = vec2(-1.0, 1.0);


float asinh_fast(float value) {
	return log(value + sqrt(value * value + 1.0));
}


vec3 depth_debug_colormap(float value) {
	float t = clamp(value, 0.0, 1.0);
	vec3 c0 = vec3(0.05, 0.02, 0.38);
	vec3 c1 = vec3(0.02, 0.40, 0.72);
	vec3 c2 = vec3(0.18, 0.75, 0.55);
	vec3 c3 = vec3(0.85, 0.75, 0.20);
	vec3 c4 = vec3(0.92, 0.35, 0.12);
	float position = t * 4.0;
	if (position < 1.0) return mix(c0, c1, smoothstep(0.0, 1.0, position));
	if (position < 2.0) return mix(c1, c2, smoothstep(0.0, 1.0, position - 1.0));
	if (position < 3.0) return mix(c2, c3, smoothstep(0.0, 1.0, position - 2.0));
	return mix(c3, c4, smoothstep(0.0, 1.0, position - 3.0));
}


void fragment() {
	if (mode < 0.5) {
		COLOR = texture(TEXTURE, UV);
	} else {
		float screen_x = FRAGCOORD.x - world_container_pos.x;
		float screen_y = FRAGCOORD.y - world_container_pos.y;
		vec2 scene_uv = vec2(screen_x / scene_size.x, screen_y / scene_size.y);
		if (scene_uv.x < 0.0 || scene_uv.x > 1.0 || scene_uv.y < 0.0 || scene_uv.y > 1.0) {
			COLOR = vec4(0.0, 0.0, 0.0, 1.0);
		} else if (mode < 1.5) {
			vec4 depth_sample = texture(depth_map, scene_uv);
			float raw_depth = (depth_sample.r * 255.0 * 256.0 + depth_sample.g * 255.0) / 65535.0;
			float mapped = depth_invert > 0.5 ? 1.0 - raw_depth : raw_depth;
			float depth = mapped * depth_scale + depth_offset;
			float transformed = asinh_fast(depth);
			float transformed_low = asinh_fast(debug_depth_range.x);
			float transformed_high = asinh_fast(debug_depth_range.y);
			float normalized = clamp((transformed - transformed_low) / max(transformed_high - transformed_low, 0.000001), 0.0, 1.0);
			COLOR = vec4(depth_debug_colormap(normalized), 1.0);
		} else if (mode < 2.5) {
			float texture_x = scene_uv.x * texture_size.x;
			float texture_y = scene_uv.y * texture_size.y;
			float floor_depth = floor_a * texture_y + floor_b;
			float projected_x = (texture_x - matrix_cx) / matrix_ppu;
			float projected_y = (matrix_cy - texture_y) / matrix_ppu;
			float world_x = matrix_r00 * projected_x + matrix_r01 * projected_y + matrix_r02 * floor_depth;
			float world_z = matrix_r20 * projected_x + matrix_r21 * projected_y + matrix_r22 * floor_depth;
			float grid_x = (world_x - collision_x_min) / collision_cell_size;
			float grid_z = (world_z - collision_z_min) / collision_cell_size;
			float is_collision = 0.0;
			if (grid_x >= 0.0 && grid_x < collision_grid_width && grid_z >= 0.0 && grid_z < collision_grid_height) {
				vec2 collision_uv = vec2(grid_x / collision_grid_width, grid_z / collision_grid_height);
				is_collision = texture(collision_map, collision_uv).r > 0.5 ? 1.0 : 0.0;
			}
			COLOR = vec4(0.0, is_collision, 0.0, 1.0);
		} else {
			COLOR = vec4(scene_uv.x, scene_uv.y, 0.0, 1.0);
		}
	}
}
