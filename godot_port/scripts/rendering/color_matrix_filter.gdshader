shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;

uniform mat4 color_matrix = mat4(1.0);
uniform vec4 color_offset = vec4(0.0);
uniform float filter_alpha : hint_range(0.0, 1.0) = 1.0;

void fragment() {
	vec4 color = textureLod(screen_texture, SCREEN_UV, 0.0);
	if (filter_alpha == 0.0) {
		COLOR *= color;
	} else {
		if (color.a > 0.0) {
			color.rgb /= color.a;
		}
		vec4 result = color_matrix * color + color_offset;
		vec3 rgb = mix(color.rgb, result.rgb, filter_alpha);
		rgb *= result.a;
		COLOR *= vec4(rgb, result.a);
	}
}
