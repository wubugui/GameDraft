shader_type canvas_item;
render_mode unshaded;

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform float strength = 0.5;

float gaussian_weight(int offset) {
	int distance = abs(offset);
	return distance == 0 ? 0.250301 : (distance == 1 ? 0.221461 : 0.153388);
}

void fragment() {
	vec2 step_uv = SCREEN_PIXEL_SIZE * strength;
	vec4 blurred = vec4(0.0);
	for (int y = -2; y <= 2; y++) {
		for (int x = -2; x <= 2; x++) {
			float weight = gaussian_weight(x) * gaussian_weight(y);
			blurred += textureLod(screen_texture, SCREEN_UV + vec2(float(x), float(y)) * step_uv, 0.0) * weight;
		}
	}
	if (blurred.a > 0.0001) {
		blurred.rgb /= blurred.a;
	}
	COLOR *= blurred;
}
