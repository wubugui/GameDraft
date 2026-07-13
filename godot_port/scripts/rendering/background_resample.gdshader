shader_type canvas_item;
render_mode unshaded;

// Godot gl_compatibility 与 Pixi/WebGL 对高密度背景缩小时的单级线性采样核不同。
// radius_texels 由源像素/屏幕像素比推导；<=0 时严格透传。
uniform vec2 radius_texels = vec2(0.0);

void fragment() {
	if (max(radius_texels.x, radius_texels.y) <= 0.0001) {
		COLOR = texture(TEXTURE, UV);
	} else {
		vec2 step_uv = TEXTURE_PIXEL_SIZE * radius_texels;
		vec4 sum = vec4(0.0);
		float weight = 0.0;
		for (int y = -1; y <= 1; y++) {
			for (int x = -1; x <= 1; x++) {
				float w = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
				vec4 tap = texture(TEXTURE, clamp(UV + vec2(float(x), float(y)) * step_uv, vec2(0.0), vec2(1.0)));
				sum.rgb += tap.rgb * tap.a * w;
				sum.a += tap.a * w;
				weight += w;
			}
		}
		float alpha = sum.a / weight;
		vec3 rgb = sum.rgb / max(sum.a, 0.000001);
		COLOR = vec4(rgb, alpha);
	}
}
