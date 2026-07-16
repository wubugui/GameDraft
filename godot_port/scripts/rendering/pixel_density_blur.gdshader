shader_type canvas_item;
render_mode unshaded;

// Pixi BlurFilter strength is expressed in rendered pixels.  Derivatives map
// one screen pixel back into the current atlas region, so camera/entity scaling
// does not silently turn the low-pass into a source-texel blur.
uniform float strength = 0.0;

void fragment() {
	vec4 color = texture(TEXTURE, UV);
	if (strength <= 0.0001) {
		COLOR = color;
	} else {
		vec2 uv_per_screen_pixel = vec2(
			length(vec2(dFdx(UV.x), dFdy(UV.x))),
			length(vec2(dFdx(UV.y), dFdy(UV.y)))
		);
		vec2 step_uv = max(uv_per_screen_pixel, TEXTURE_PIXEL_SIZE) * strength;
		vec2 region_min = REGION_RECT.xy + TEXTURE_PIXEL_SIZE * 0.5;
		vec2 region_max = REGION_RECT.xy + REGION_RECT.zw - TEXTURE_PIXEL_SIZE * 0.5;
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
		COLOR = vec4(sum.rgb / max(sum.a, 0.000001), alpha);
	}
}
