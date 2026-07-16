class_name RuntimeShopUI
extends RefCounted

const PANEL_WIDTH := 500.0
const ITEM_HEIGHT := 36.0

var renderer: RuntimeRenderer
var event_bus: RuntimeEventBus
var inventory: RuntimeInventoryManager
var strings: RuntimeStringsProvider
var asset_manager: RuntimeAssetManager
var root: Control
var current_shop: Dictionary = {}
var shop_defs: Dictionary = {}
var _resolve_display := Callable()


func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, inventory_data: RuntimeInventoryManager, next_strings: RuntimeStringsProvider, assets: RuntimeAssetManager) -> void:
	renderer = next_renderer
	event_bus = events
	inventory = inventory_data
	strings = next_strings
	asset_manager = assets


func set_resolve_display(callback: Callable = Callable()) -> void:
	_resolve_display = callback


func load_defs() -> bool:
	shop_defs.clear()
	var raw: Variant = asset_manager.load_json("/assets/data/shops.json")
	if not raw is Array:
		return false
	for value: Variant in raw:
		if value is Dictionary and not str(value.get("id", "")).strip_edges().is_empty() and value.get("items") is Array:
			shop_defs[str(value.id)] = value.duplicate(true)
	return true


func open() -> void:
	# Source ShopUI also requires the explicit openShop(shopId) entrypoint.
	return


func open_shop(id: String) -> bool:
	var definition: Variant = shop_defs.get(id)
	if not definition is Dictionary:
		return false
	current_shop = definition.duplicate(true)
	event_bus.emit("shop:opened", {"shopId": id})
	_build()
	return true


func close() -> void:
	if not is_open():
		return
	_destroy_ui()
	current_shop.clear()
	event_bus.emit("shop:closed", {})


func is_open() -> bool:
	return root != null


func get_shop_ids() -> Array:
	return shop_defs.keys()


func get_item_count() -> int:
	return current_shop.get("items", []).size() if current_shop.get("items") is Array else 0


func get_row_state(item_id: String) -> Dictionary:
	var button: Variant = root.get_node_or_null("Panel/Rows/%s/Buy" % item_id) if root != null else null
	return {"enabled": button is Button and not button.disabled, "text": button.text if button is Button else ""}


func debug_purchase(item_id: String) -> void:
	if not current_shop.get("items") is Array:
		return
	for item: Variant in current_shop.items:
		if item is Dictionary and str(item.get("itemId", "")) == item_id:
			var definition: Variant = inventory.get_item_def(item_id)
			var price := float(item.get("price", definition.get("buyPrice", 0) if definition is Dictionary else 0))
			if inventory.get_coins() >= price:
				_purchase(item_id, price)
			return


func destroy() -> void:
	_destroy_ui()
	current_shop.clear()
	shop_defs.clear()
	_resolve_display = Callable()


func _build() -> void:
	_destroy_ui()
	if current_shop.is_empty():
		return
	var screen := Vector2(renderer.screen_width, renderer.screen_height)
	var items: Array = current_shop.get("items", [])
	var panel_height := 120.0 + items.size() * ITEM_HEIGHT
	root = Control.new()
	root.name = "ShopUI"
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	var shade := ColorRect.new()
	shade.color = Color(0.0, 0.0, 0.0, 0.5)
	shade.size = screen
	shade.mouse_filter = Control.MOUSE_FILTER_STOP
	root.add_child(shade)
	var panel := Panel.new()
	panel.name = "Panel"
	panel.position = Vector2((screen.x - PANEL_WIDTH) / 2.0, (screen.y - panel_height) / 2.0)
	panel.size = Vector2(PANEL_WIDTH, panel_height)
	var style := StyleBoxFlat.new()
	style.bg_color = Color("151a24")
	style.border_color = Color("8c7244")
	style.set_border_width_all(2)
	style.set_corner_radius_all(7)
	panel.add_theme_stylebox_override("panel", style)
	root.add_child(panel)
	var title := Label.new()
	title.text = _text(str(current_shop.get("name", "")))
	title.position = Vector2(20, 12)
	title.size = Vector2(330, 28)
	title.add_theme_font_size_override("font_size", 18)
	title.add_theme_color_override("font_color", Color("e8cf8e"))
	panel.add_child(title)
	var coins := Label.new()
	coins.name = "Coins"
	coins.text = "%s %s" % [strings.get_text("shop", "coins"), inventory.get_coins()]
	coins.position = Vector2(365, 14)
	coins.size = Vector2(115, 24)
	coins.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	coins.add_theme_color_override("font_color", Color("c7a761"))
	panel.add_child(coins)
	var rows := VBoxContainer.new()
	rows.name = "Rows"
	rows.position = Vector2(20, 50)
	rows.size = Vector2(PANEL_WIDTH - 40, items.size() * ITEM_HEIGHT)
	panel.add_child(rows)
	for raw: Variant in items:
		if not raw is Dictionary:
			continue
		var item_id := str(raw.get("itemId", ""))
		var item_def: Variant = inventory.get_item_def(item_id)
		var price := float(raw.get("price", item_def.get("buyPrice", 0) if item_def is Dictionary else 0))
		var row := HBoxContainer.new()
		row.name = item_id
		row.custom_minimum_size = Vector2(rows.size.x, ITEM_HEIGHT - 4)
		var name_label := Label.new()
		name_label.text = _text(str(item_def.get("name", item_id) if item_def is Dictionary else item_id))
		name_label.custom_minimum_size = Vector2(280, ITEM_HEIGHT - 4)
		name_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(name_label)
		var price_label := Label.new()
		price_label.text = "%s %s" % [price, strings.get_text("shop", "unit")]
		price_label.custom_minimum_size = Vector2(80, ITEM_HEIGHT - 4)
		price_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(price_label)
		var buy := Button.new()
		buy.name = "Buy"
		buy.text = strings.get_text("shop", "buy") if inventory.get_coins() >= price else strings.get_text("shop", "insufficient")
		buy.disabled = inventory.get_coins() < price
		buy.custom_minimum_size = Vector2(90, ITEM_HEIGHT - 4)
		buy.pressed.connect(Callable(self, "_purchase").bind(item_id, price))
		row.add_child(buy)
		rows.add_child(row)
	var close_button := Button.new()
	close_button.name = "Close"
	close_button.text = strings.get_text("shop", "leave")
	close_button.position = Vector2((PANEL_WIDTH - 100) / 2.0, panel_height - 42)
	close_button.size = Vector2(100, 30)
	close_button.pressed.connect(Callable(self, "close"))
	panel.add_child(close_button)
	renderer.ui_layer.add_child(root)


func _purchase(item_id: String, price: float) -> void:
	event_bus.emit("shop:purchase", {"itemId": item_id, "price": price})
	_build()


func _destroy_ui() -> void:
	if root != null and is_instance_valid(root):
		if root.get_parent() != null:
			root.get_parent().remove_child(root)
		root.free()
	root = null


func _text(raw: String) -> String:
	return str(_resolve_display.call(raw)) if _resolve_display.is_valid() else raw
