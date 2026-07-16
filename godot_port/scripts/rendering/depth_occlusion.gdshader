shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D collision_map : filter_nearest, repeat_disable;
uniform float canvas_group_target = 0.0;
uniform vec2 scene_size = vec2(0.0);
uniform float projection_scale = 1.0;
uniform float world_to_pixel_x = 1.0;
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
uniform vec2 world_container_pos = vec2(0.0);
uniform float entity_foot_world_y = 0.0;
uniform float debug_mode = 0.0;
uniform float occlusion_blend_factor : hint_range(0.0, 1.0) = 0.0;
uniform float matrix_ppu = 1.0;
uniform float matrix_cx = 0.0;
uniform float matrix_cy = 0.0;
uniform vec3 matrix_row0 = vec3(0.0);
uniform vec3 matrix_row2 = vec3(0.0);
uniform float collision_x_min = 0.0;
uniform float collision_z_min = 0.0;
uniform float collision_cell_size = 1.0;
uniform float collision_grid_width = 0.0;
uniform float collision_grid_height = 0.0;
uniform float pixel_blur_strength = 0.0;

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
	vec2 depth_uv = vec2(world_x / scene_size.x, world_y / scene_size.y);
	if (depth_uv.x < 0.0 || depth_uv.x > 1.0 || depth_uv.y < 0.0 || depth_uv.y > 1.0) {
		COLOR = color;
	} else {
		vec4 depth_sample = texture(depth_map, depth_uv);
		float raw_depth = (depth_sample.r * 255.0 * 256.0 + depth_sample.g * 255.0) / 65535.0;
		float scene_depth = (depth_invert > 0.5 ? 1.0 - raw_depth : raw_depth) * depth_scale + depth_offset;
		float foot_sy = entity_foot_world_y * world_to_pixel_y;
		float pixel_sy = world_y * world_to_pixel_y;
		float base_depth = floor_a * foot_sy + floor_b + floor_offset + floor_offset_extra;
		float sprite_depth = base_depth + depth_per_sy * (pixel_sy - foot_sy);
		bool occluded = scene_depth + tolerance < sprite_depth;
		if (debug_mode > 0.5) {
			float pixel_x = world_x * world_to_pixel_x;
			float projected_x = (pixel_x - matrix_cx) / matrix_ppu;
			float projected_y = (matrix_cy - pixel_sy) / matrix_ppu;
			float floor_depth = floor_a * pixel_sy + floor_b;
			float pseudo_x = dot(matrix_row0, vec3(projected_x, projected_y, floor_depth));
			float pseudo_z = dot(matrix_row2, vec3(projected_x, projected_y, floor_depth));
			float grid_x = (pseudo_x - collision_x_min) / collision_cell_size;
			float grid_z = (pseudo_z - collision_z_min) / collision_cell_size;
			float collision = 0.0;
			if (grid_x >= 0.0 && grid_x < collision_grid_width && grid_z >= 0.0 && grid_z < collision_grid_height) {
				collision = texture(collision_map, vec2(grid_x / collision_grid_width, grid_z / collision_grid_height)).r > 0.5 ? 1.0 : 0.0;
			}
			COLOR = vec4(occluded ? 1.0 : 0.0, collision, 0.0, 0.7);
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
