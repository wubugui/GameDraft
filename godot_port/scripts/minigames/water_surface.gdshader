shader_type canvas_item;

uniform sampler2D params_texture : filter_linear, repeat_disable;
uniform float elapsed_time = 0.0;
uniform float murk = 0.35;
uniform float darkness = 0.0;
uniform float rain = 0.0;
uniform vec3 sigma = vec3(0.85, 1.25, 1.75);
uniform float min_alpha = 0.1;
uniform float water_bottom_depth = 1.0;
uniform vec2 filter_uv_scale = vec2(1.0);

void fragment() {
	// Pixi's filter input is a power-of-two pooled texture. vTextureCoord spans
	// only the valid content rectangle; sampling that rectangle still covers the
	// complete rendered image. Keep the procedural/depth coordinate in that
	// compact domain, then remap only the texture lookup back to Godot's 0..1 RT.
	vec2 uv = UV * filter_uv_scale;
	vec2 ripple = vec2(
		sin(uv.x * 48.0 + elapsed_time * 1.7) * cos(uv.y * 31.0 - elapsed_time * 1.1),
		cos(uv.y * 44.0 + elapsed_time * 1.4) * sin(uv.x * 29.0 + elapsed_time * 0.9)
	) * 0.012 * (0.35 + murk);
	vec2 suv = clamp(uv + ripple, vec2(0.001), max(filter_uv_scale - vec2(0.001), vec2(0.001)));
	vec2 sample_uv = suv / max(filter_uv_scale, vec2(0.000001));
	vec4 col = texture(TEXTURE, sample_uv);
	vec4 pm = texture(params_texture, sample_uv);
	float object_mask = step(0.5, pm.b) * pm.a;
	float background_path = max(water_bottom_depth * suv.y, 0.0001);
	float entity_path = max(water_bottom_depth * max(pm.r, 0.0), 0.0001);
	float optical_path = mix(background_path, entity_path, object_mask);
	col.rgb *= exp(-sigma * optical_path * (1.2 + murk * 2.5));
	col.rgb *= clamp(1.0 - darkness, 0.15, 1.0);
	float fog_amount = murk * 0.35 + rain * 0.08;
	col.rgb = mix(col.rgb, vec3(0.55, 0.62, 0.72), clamp(fog_amount, 0.0, 0.85));
	col.rgb += vec3(0.82, 0.90, 1.0) * object_mask * pm.g * 0.48;
	col.rgb = mix(col.rgb, vec3(0.72, 0.78, 0.88), rain * 0.22);
	col.a = max(col.a, min_alpha);
	COLOR = col;
}
