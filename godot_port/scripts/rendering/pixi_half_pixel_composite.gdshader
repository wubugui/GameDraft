shader_type canvas_item;
render_mode unshaded;

// Pixi's WebGL sprite/UI stack lands half a screen pixel later on X than
// Godot's CanvasItem rasterizer. Sample the already-composited CanvasGroup at
// that phase so premultiplied transparent edges remain in the same order.
uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;

void fragment() {
	vec2 phase_uv = vec2(SCREEN_PIXEL_SIZE.x * 0.5, 0.0);
	COLOR *= textureLod(screen_texture, SCREEN_UV + phase_uv, 0.0);
}
