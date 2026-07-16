class_name RuntimeSceneDepthFilterAdapter
extends RefCounted


static func build_probe_texture(background: Texture2D) -> Texture2D:
	if background == null:
		return null
	var image := background.get_image()
	if image == null or image.is_empty():
		return background
	var target_width := mini(96, image.get_width())
	var target_height := maxi(1, int(round(float(image.get_height()) * target_width / maxf(1.0, image.get_width()))))
	image.resize(target_width, target_height, Image.INTERPOLATE_LANCZOS)
	image.generate_mipmaps()
	return ImageTexture.create_from_image(image)
