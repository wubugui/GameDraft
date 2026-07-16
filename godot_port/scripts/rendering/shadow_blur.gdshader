shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform float strength = 0.5;
uniform vec2 direction = vec2(1.0, 0.0);

void fragment() {
	vec2 step_uv = direction * SCREEN_PIXEL_SIZE * strength;
	vec4 blurred = textureLod(screen_texture, SCREEN_UV - step_uv * 2.0, 0.0) * 0.153388;
	blurred += textureLod(screen_texture, SCREEN_UV - step_uv, 0.0) * 0.221461;
	blurred += textureLod(screen_texture, SCREEN_UV, 0.0) * 0.250301;
	blurred += textureLod(screen_texture, SCREEN_UV + step_uv, 0.0) * 0.221461;
	blurred += textureLod(screen_texture, SCREEN_UV + step_uv * 2.0, 0.0) * 0.153388;
	if (blurred.a > 0.0001) {
		blurred.rgb /= blurred.a;
	}
	COLOR *= blurred;
}
