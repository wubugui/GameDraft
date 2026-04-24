"""Extraction rules: defines which JSON fields contain translatable text."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class FieldRule:
    """Rule for extracting text from a JSON field."""
    fields: list[str]
    category: str
    tags_from_id: str | None = None  # e.g. "quest_id" → tag "quest_id:{id}"


# --- JSON file extraction rules ---
# Key: relative path from project root
# Value: list of field rules
JSON_EXTRACTION_RULES: dict[str, FieldRule] = {
    "public/assets/data/quests.json": FieldRule(
        fields=["title", "description"],
        category="quest",
        tags_from_id="quest_id",
    ),
    "public/assets/data/rules.json": FieldRule(
        fields=["name", "incompleteName"],
        category="rule",
        tags_from_id="rule_id",
    ),
    "public/assets/data/items.json": FieldRule(
        fields=["name", "description"],
        category="item",
        tags_from_id="item_id",
    ),
    "public/assets/data/encounters.json": FieldRule(
        fields=["narrative"],
        category="encounter",
        tags_from_id="encounter_id",
    ),
    "public/assets/data/scenarios.json": FieldRule(
        fields=["description", "exposeAfterPhase"],
        category="scenario",
        tags_from_id="scenario_id",
    ),
    "public/assets/data/shops.json": FieldRule(
        fields=["name"],
        category="shop",
        tags_from_id="shop_id",
    ),
    "public/assets/data/map_config.json": FieldRule(
        fields=["name"],
        category="map",
        tags_from_id="scene_id",
    ),
    "public/assets/data/archive/characters.json": FieldRule(
        fields=["name", "title"],
        category="archive",
        tags_from_id="char_id",
    ),
    "public/assets/data/archive/lore.json": FieldRule(
        fields=["title", "content", "source"],
        category="archive",
        tags_from_id="lore_id",
    ),
    "public/assets/data/archive/documents.json": FieldRule(
        fields=["name", "content", "annotation"],
        category="archive",
        tags_from_id="doc_id",
    ),
    "public/assets/data/archive/books.json": FieldRule(
        fields=["title"],
        category="archive",
        tags_from_id="book_id",
    ),
}

# Sub-path rules (fields inside nested arrays)
NESTED_EXTRACTION_RULES: dict[str, list[tuple[str, list[str]]]] = {
    # file_rel_path -> [(sub_path, fields_to_extract), ...]
    "public/assets/data/rules.json": [
        ("fragments", ["text", "source"]),
    ],
    "public/assets/data/items.json": [
        ("dynamicDescriptions", ["text"]),
    ],
    "public/assets/data/encounters.json": [
        ("options", ["text", "resultText"]),
    ],
    "public/assets/data/archive/characters.json": [
        ("impressions", ["text"]),
        ("knownInfo", ["text"]),
    ],
    "public/assets/data/archive/books.json": [
        ("pages", ["title", "content"]),
        ("pages.entries", ["title", "content", "annotation"]),
    ],
}

# Context templates per file_type — shown as dropdown defaults in the detail panel
CONTEXT_TEMPLATES: dict[str, str] = {
    "ink_dialogue": "Dialogue spoken by {speaker} in knot {knot}. Context: ",
    "ink_choice": "Player choice text in knot {knot}. Speaker: {speaker}. Context: ",
    "ink_thought": "Internal thought / narration. First-person perspective of the player character. Context: ",
    "ink_narration": "Narrative text (no specific speaker). Context: ",
    "json_quests": "Quest text shown in the quest log and HUD notifications. ",
    "json_rules": "Rule text shown in the rules/tabby menu. ",
    "json_items": "Item name/description shown in inventory. ",
    "json_encounters": "Narrative text for random encounter scenes and choices. ",
    "json_scenarios": "Scenario description shown in the map/status panel. ",
    "json_archive": "Archive entry (character profile, lore, document, or book). Read-only reference text. ",
    "json_map": "Map node name shown on the world map. ",
    "json_shop": "Shop name shown in the shop UI header. ",
    "cutscenes": "Cutscene dialogue or title text. ",
}

# Status values
STATUSES = ["pending", "reviewed", "translated", "optimized"]

# File type → readable label
FILE_TYPE_LABELS: dict[str, str] = {
    "json_strings": "UI Strings",
    "json_quests": "Quests",
    "json_rules": "Rules & Fragments",
    "json_items": "Items",
    "json_encounters": "Encounters",
    "json_scenarios": "Scenarios",
    "json_shops": "Shops",
    "json_map": "Map Nodes",
    "json_archive": "Archive",
    "ink_dialogue": "Ink Dialogue",
    "ink_choice": "Ink Choice",
    "ink_thought": "Ink Thought",
    "ink_narration": "Ink Narration",
    "cutscenes_title": "Cutscene Title",
    "cutscenes_dialogue": "Cutscene Dialogue",
    "cutscenes_speaker": "Cutscene Speaker",
    "cutscenes_actor_name": "Cutscene Actor Name",
}

# Category → readable label
CATEGORY_LABELS: dict[str, str] = {
    "ui": "UI",
    "quest": "Quest",
    "rule": "Rule",
    "item": "Item",
    "encounter": "Encounter",
    "scenario": "Scenario",
    "shop": "Shop",
    "map": "Map",
    "archive": "Archive",
    "dialogue": "Dialogue",
    "cutscene": "Cutscene",
}

# Default languages to show in the translation panel
DEFAULT_LANGUAGES = ["en", "ja"]
