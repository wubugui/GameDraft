shader_type canvas_item;

uniform float depth_value = 0.5;
uniform float glow_value = 0.0;

void fragment() {
	float alpha = texture(TEXTURE, UV).a;
	if (alpha < 0.004) {
		discard;
	}
	COLOR = vec4(depth_value, glow_value, 1.0, alpha);
}
