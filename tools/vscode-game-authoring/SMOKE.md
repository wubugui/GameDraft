# Spatial Picker Smoke Tests

All tests use the `teahouse` scene (`public/assets/scenes/teahouse.json`).

## Prerequisites

- Extension compiled (`npm run compile`)
- Workspace open at GameDraft root
- An authoring YAML open in the editor (e.g. `authoring/dialogues/npc/sample_intro.yaml`)

---

## 1. Auto-detect dispatch (`pickSpatialField`)

Command: `Game Authoring: Pick Spatial Field (auto-detect)`

| Cursor on line | Expected dispatch |
|---|---|
| `  x: 100` | Opens map position picker |
| `  polygon:` | Opens polygon editor picker → zone list |
| `  route:` | Opens route editor → NPC list |
| `  spawnPoint: from_street` | Opens spawn QuickPick |
| `  zone: safe` | Opens zone QuickPick |
| `  entity: blind_li` | Opens entity QuickPick |
| `  targetScene: teahouse` | Opens scene QuickPick, writes selected scene ID back |
| `  unknownKey: foo` | Falls back to map position picker |

---

## 2. Spawn point picker (`pickSpawn`)

1. Run `Game Authoring: Pick Spawn Point`.
2. Select scene `teahouse`.
3. Confirm QuickPick shows: `spawnPoint` (default spawn), `from_street` (named spawn).
4. Pick `from_street`.
5. Verify cursor line value replaced with `from_street`.
6. No extra diagnostics triggered.

---

## 3. Zone picker (`pickZone`)

1. Run `Game Authoring: Pick Zone`.
2. Select `teahouse` — no zones defined in the scene.
3. Confirm warning: "No zones found in this scene."
4. (After adding a zone to teahouse.json manually) re-run; confirm zone ID appears and writes back.

---

## 4. Entity picker (`pickEntity`)

1. Run `Game Authoring: Pick Entity`.
2. Select `teahouse`.
3. Confirm list shows NPCs: `storyteller_zhang`, `blind_li`, `waiter_xiaoer` (kind: npc) and hotspots: `teahouse_notice`, `teahouse_table_items`, etc. (kind: hotspot).
4. Pick `blind_li`.
5. Verify cursor line value replaced with `blind_li`.

---

## 5. Polygon editor (`pickPolygon`)

1. Run `Game Authoring: Edit Polygon`.
2. Select `teahouse` — no zones → prompted for new zone ID, enter `test_zone`.
3. Webview opens with teahouse background image (or missing-bg placeholder).
4. Click 3+ points on the map to add vertices.
5. Drag a vertex to reposition it.
6. Click an edge midpoint (small green dot) to insert a vertex.
7. Right-click a vertex to delete (must keep ≥3 — verify warning appears for <3).
8. Press **Undo** — last change reverted.
9. Press **Snap 10: OFF** → toggles to ON; next clicks snap to grid.
10. Press **Apply**.
11. Verify `teahouse.json` updated: `zones` array contains `test_zone` with correct polygon.
12. Verify the file opened in VS Code reflects the update (if it was open).

---

## 6. Patrol route editor (`pickRoute`)

1. Run `Game Authoring: Edit Patrol Route`.
2. Select `teahouse`.
3. Pick `storyteller_zhang` (has 2 waypoints).
4. Webview opens showing teal base position dot and blue dashed route with arrows.
5. Drag a waypoint to move it.
6. Click empty map area to add a new waypoint.
7. Right-click a waypoint to delete it.
8. Press **Apply**.
9. Verify `teahouse.json` `npcs[storyteller_zhang].patrol.route` updated.
10. Verify base position `{x:485.7, y:431.6}` is NOT in the written route array.

---

## 7. Conflict detection

1. Open `teahouse.json` in another editor and make an unsaved edit.
2. Open route editor for `storyteller_zhang`, make a change, press Apply.
3. Verify: write-back detects external modification and shows warning instead of overwriting.

---

## 8. Write-back triggers diagnostics

1. Pick any ID via entity/spawn picker.
2. After write, observe the VS Code Problems panel refreshes (diagnostic count updates).
