shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D collision_map : filter_nearest, repeat_disable;
uniform sampler2D silhouette_map : filter_linear, repeat_disable;
uniform float darkness = 0.4;
uniform float collision_enabled = 0.0;
uniform float occlusion_enabled = 0.0;
uniform vec2 scene_size = vec2(1.0);
uniform vec2 world_to_pixel = vec2(1.0);
uniform float foot_x = 0.0;
uniform float foot_y = 0.0;
uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;
uniform float floor_a = 0.0;
uniform float floor_b = 0.0;
uniform float floor_offset = 0.0;
uniform float tolerance = 0.0;
uniform float occlusion_blend = 0.28;
uniform float matrix_ppu = 1.0;
uniform vec2 matrix_center = vec2(0.0);
uniform vec3 matrix_row0 = vec3(0.0);
uniform vec3 matrix_row2 = vec3(0.0);
uniform vec2 collision_origin = vec2(0.0);
uniform float collision_cell = 1.0;
uniform vec2 collision_grid = vec2(0.0);

varying vec2 world_position;

void vertex() {
	world_position = VERTEX;
}

bool collision_at(vec2 position) {
	float sx = position.x * world_to_pixel.x;
	float sy = position.y * world_to_pixel.y;
	float floor_depth = floor_a * sy + floor_b;
	float px = (sx - matrix_center.x) / max(matrix_ppu, 0.000001);
	float py = (matrix_center.y - sy) / max(matrix_ppu, 0.000001);
	float world_x = dot(matrix_row0, vec3(px, py, floor_depth));
	float world_z = dot(matrix_row2, vec3(px, py, floor_depth));
	vec2 grid = (vec2(world_x, world_z) - collision_origin) / max(collision_cell, 0.000001);
	if (grid.x < 0.0 || grid.x >= collision_grid.x || grid.y < 0.0 || grid.y >= collision_grid.y) return false;
	return texture(collision_map, grid / max(collision_grid, vec2(1.0))).r > 0.5;
}

void fragment() {
	float silhouette = texture(silhouette_map, UV).a;
	if (silhouette < 0.01) discard;
	float alpha = silhouette * darkness;
	if (collision_enabled > 0.5) {
		vec2 foot = vec2(foot_x, foot_y);
		vec2 direction = world_position - foot;
		bool blocked = false;
		for (int index = 1; index <= 24; index++) {
			if (collision_at(foot + direction * (float(index) / 24.0))) { blocked = true; break; }
		}
		if (blocked) discard;
	}
	if (occlusion_enabled > 0.5) {
		vec2 depth_uv = world_position / max(scene_size, vec2(0.000001));
		if (all(greaterThanEqual(depth_uv, vec2(0.0))) && all(lessThanEqual(depth_uv, vec2(1.0)))) {
			vec4 encoded = texture(depth_map, depth_uv);
			float raw = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
			float mapped = mix(raw, 1.0 - raw, step(0.5, depth_invert)) * depth_scale + depth_offset;
			float shadow_depth = floor_a * (world_position.y * world_to_pixel.y) + floor_b + floor_offset;
			if (mapped + tolerance < shadow_depth) alpha *= occlusion_blend;
		}
	}
	COLOR = vec4(0.0, 0.0, 0.0, alpha);
}
