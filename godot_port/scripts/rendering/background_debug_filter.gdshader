shader_type canvas_item;
render_mode unshaded;

uniform sampler2D depth_map : filter_nearest, repeat_disable;
uniform sampler2D collision_map : filter_nearest, repeat_disable;
uniform float mode = 0.0;
uniform vec2 texture_size = vec2(1.0);
uniform float depth_invert = 0.0;
uniform float depth_scale = 1.0;
uniform float depth_offset = 0.0;
uniform vec2 debug_depth_range = vec2(-1.0, 1.0);

vec3 depth_colormap(float t) {
	vec3 c0 = vec3(0.05, 0.02, 0.38);
	vec3 c1 = vec3(0.02, 0.40, 0.72);
	vec3 c2 = vec3(0.18, 0.75, 0.55);
	vec3 c3 = vec3(0.85, 0.75, 0.20);
	vec3 c4 = vec3(0.92, 0.35, 0.12);
	float p = clamp(t, 0.0, 1.0) * 4.0;
	if (p < 1.0) return mix(c0, c1, smoothstep(0.0, 1.0, p));
	if (p < 2.0) return mix(c1, c2, smoothstep(0.0, 1.0, p - 1.0));
	if (p < 3.0) return mix(c2, c3, smoothstep(0.0, 1.0, p - 2.0));
	return mix(c3, c4, smoothstep(0.0, 1.0, p - 3.0));
}

void fragment() {
	if (mode < 0.5) { COLOR = texture(TEXTURE, UV); }
	else if (mode < 1.5) {
		vec4 encoded = texture(depth_map, UV);
		float raw = (encoded.r * 255.0 * 256.0 + encoded.g * 255.0) / 65535.0;
		float depth = mix(raw, 1.0 - raw, step(0.5, depth_invert)) * depth_scale + depth_offset;
		float lo = asinh(debug_depth_range.x);
		float hi = asinh(debug_depth_range.y);
		COLOR = vec4(depth_colormap((asinh(depth) - lo) / max(hi - lo, 0.000001)), 1.0);
	} else if (mode < 2.5) {
		COLOR = vec4(0.0, step(0.5, texture(collision_map, UV).r), 0.0, 1.0);
	} else {
		COLOR = vec4(UV, 0.0, 1.0);
	}
}
