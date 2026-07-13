shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D silhouette_map : filter_linear, repeat_disable;
uniform vec2 scene_size = vec2(1.0);
uniform vec2 world_to_pixel = vec2(1.0);
uniform float matrix_ppu = 1.0;
uniform vec2 matrix_center = vec2(0.0);
uniform vec3 matrix_row0 = vec3(0.0);
uniform vec3 matrix_row1 = vec3(0.0);
uniform vec3 matrix_row2 = vec3(0.0);
uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;
uniform vec2 foot = vec2(0.0);
uniform float height_m = 1.0;
uniform float width_m = 1.0;
uniform float facing = 1.0;
uniform float billboard_mode = 0.0;
uniform vec3 light_direction = vec3(0.0, 1.0, 0.0);
uniform float darkness = 0.4;
uniform float soft_samples = 1.0;
uniform float soft_radius = 0.05;
uniform float contact_ao = 0.0;
uniform float contact_radius = 1.0;
uniform vec4 silhouette_frame = vec4(0.0, 0.0, 1.0, 1.0);
uniform vec2 silhouette_texel_size = vec2(0.001);
uniform float silhouette_softness = 0.0;

varying vec2 world_position;

void vertex() {
	world_position = VERTEX;
}

vec3 reconstruct(vec2 world_xy, float depth) {
	float sx = world_xy.x * world_to_pixel.x;
	float sy = world_xy.y * world_to_pixel.y;
	float px = (sx - matrix_center.x) / max(matrix_ppu, 0.000001);
	float py = (matrix_center.y - sy) / max(matrix_ppu, 0.000001);
	vec3 right = vec3(matrix_row0.x, matrix_row1.x, matrix_row2.x);
	vec3 up = vec3(matrix_row0.y, matrix_row1.y, matrix_row2.y);
	vec3 view_direction = vec3(matrix_row0.z, matrix_row1.z, matrix_row2.z);
	return right * px + up * py + view_direction * depth;
}

float sample_silhouette(vec2 uv) {
	if (silhouette_softness <= 0.0001) return step(0.5, texture(silhouette_map, uv).a);
	vec2 delta = silhouette_texel_size * max(0.5, silhouette_softness * 4.0);
	float alpha = texture(silhouette_map, uv).a * 4.0;
	alpha += texture(silhouette_map, uv + vec2(delta.x, 0.0)).a * 2.0;
	alpha += texture(silhouette_map, uv - vec2(delta.x, 0.0)).a * 2.0;
	alpha += texture(silhouette_map, uv + vec2(0.0, delta.y)).a * 2.0;
	alpha += texture(silhouette_map, uv - vec2(0.0, delta.y)).a * 2.0;
	alpha += texture(silhouette_map, uv + delta).a;
	alpha += texture(silhouette_map, uv - delta).a;
	alpha += texture(silhouette_map, uv + vec2(delta.x, -delta.y)).a;
	alpha += texture(silhouette_map, uv + vec2(-delta.x, delta.y)).a;
	return alpha / 16.0;
}

float hit_silhouette(vec3 surface, vec3 foot_world, vec3 light, vec3 world_up, vec3 horizontal_axis) {
	vec3 normal = normalize(cross(horizontal_axis, world_up));
	float denominator = dot(light, normal);
	if (abs(denominator) < 0.00001) return 0.0;
	float distance_to_plane = dot(foot_world - surface, normal) / denominator;
	if (distance_to_plane <= 0.0001) return 0.0;
	vec3 relative = (surface + light * distance_to_plane) - foot_world;
	float vertical = dot(relative, world_up);
	float horizontal = dot(relative, horizontal_axis);
	if (vertical < 0.0 || vertical > height_m || abs(horizontal) > width_m * 0.5) return 0.0;
	float u = horizontal / max(width_m, 0.000001) + 0.5;
	if (facing < 0.0) u = 1.0 - u;
	float v = 1.0 - vertical / max(height_m, 0.000001);
	return sample_silhouette(silhouette_frame.xy + vec2(u, v) * silhouette_frame.zw);
}

float decode_depth(vec2 uv) {
	vec4 encoded = texture(depth_map, uv);
	float raw = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
	return mix(raw, 1.0 - raw, step(0.5, depth_invert)) * depth_scale + depth_offset;
}

void fragment() {
	vec2 depth_uv = world_position / max(scene_size, vec2(0.000001));
	if (any(lessThan(depth_uv, vec2(0.0))) || any(greaterThan(depth_uv, vec2(1.0)))) discard;
	vec3 surface = reconstruct(world_position, decode_depth(depth_uv));
	vec2 foot_uv = foot / max(scene_size, vec2(0.000001));
	vec3 foot_world = reconstruct(foot, decode_depth(foot_uv));
	vec3 world_up = vec3(0.0, 1.0, 0.0);
	vec3 light = normalize(light_direction);
	vec3 camera_right = normalize(vec3(matrix_row0.x, matrix_row1.x, matrix_row2.x));
	vec3 horizontal_axis;
	if (billboard_mode > 0.5) {
		horizontal_axis = camera_right;
	} else {
		vec3 horizontal = cross(world_up, light);
		horizontal_axis = length(horizontal) > 0.0001 ? normalize(horizontal) : camera_right;
	}
	float occlusion = 0.0;
	int count = clamp(int(round(soft_samples)), 1, 8);
	if (count <= 1) {
		occlusion = hit_silhouette(surface, foot_world, light, world_up, horizontal_axis);
	} else {
		vec3 tangent1 = horizontal_axis;
		vec3 tangent2 = normalize(cross(light, tangent1));
		for (int index = 0; index < 8; index++) {
			if (index < count) {
				float angle = 6.2831853 * float(index) / float(count);
				vec3 jittered = normalize(light + soft_radius * (cos(angle) * tangent1 + sin(angle) * tangent2));
				occlusion += hit_silhouette(surface, foot_world, jittered, world_up, horizontal_axis);
			}
		}
		occlusion /= float(count);
	}
	float contact = contact_ao * (1.0 - smoothstep(0.0, max(contact_radius, 0.001), length(world_position - foot)));
	float darken = max(occlusion * darkness, contact);
	if (darken < 0.01) discard;
	COLOR = vec4(0.0, 0.0, 0.0, darken);
}
