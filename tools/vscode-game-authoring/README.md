# GameDraft Authoring Tools

This is a local VS Code extension for GameDraft graph authoring. It is not active just because the source code exists in the repo. You must either run it in an Extension Development Host or package/install it.

## What It Provides

For files under `authoring/**/*.yaml`, `authoring/**/*.yml`, and `authoring/**/*.csv`:

```text
1. diagnostics from the content pipeline
2. completion for flags, signals, quests, graph ids, states, action types, action params, scenes
3. hover info from content_index.json
4. go to definition
5. find references
6. rename symbol
7. document/workspace symbols
8. code actions for undeclared flags/signals/quests and action schema help
9. graph/reference webviews
10. spatial pickers for scene/zone/entity/spawn/map point/polygon/route
```

## First-Time Setup

From the repository root:

```powershell
npm --prefix tools/vscode-game-authoring install
npm --prefix tools/vscode-game-authoring run compile
npm run content:build
```

`content:build` is important because completion/hover/reference views read:

```text
artifact/content_pipeline/content_index.json
artifact/content_pipeline/source_map.json
artifact/content_pipeline/runtime_preview/**
```

## How To Make It Active

### Option A: Extension Development Host

Use this when developing the extension:

```text
1. Open the GameDraft repo in VS Code.
2. Open the Run and Debug panel.
3. Select "Run GameDraft Authoring Tools".
4. Press F5.
5. A new "Extension Development Host" VS Code window opens with D:\GameDraft.
6. Press Ctrl+Shift+P and run "Game Authoring: Open Planner Dashboard".
```

If you only open the repo in a normal VS Code window, the local extension source is not automatically installed.

### Option B: Package And Install

Use this when you want the extension in your normal VS Code window.

Install `vsce` if needed:

```powershell
npm install -g @vscode/vsce
```

Package and install from the repository root:

```powershell
npm --prefix tools/vscode-game-authoring run install:local
```

Then reload VS Code and open `D:\GameDraft`.

The extension activates when the workspace contains:

```text
authoring/project.yaml
```

## Quick Smoke Test

After the extension is active:

```text
1. Open authoring/dialogues/npc/ringboy.yaml.
2. Press Ctrl+Shift+P.
3. Run "Game Authoring: Open Planner Dashboard".
4. In the dashboard, click "Build Content".
5. Click "Refresh Diagnostics".
6. Put cursor after `signal:` and press Ctrl+Space. Signal completions should appear.
7. Hover a known id like `ring_taken`. A GameDraft hover card should appear.
8. Right-click a known id and use "Go to Definition" or "Find References".
9. Use the dashboard's graph/reference buttons.
```

## Spatial Picker Smoke Tests

See:

```text
tools/vscode-game-authoring/SMOKE.md
```

## Graph / Reference View Smoke Tests

See:

```text
tools/vscode-game-authoring/GRAPH_REFERENCE_VIEWS_SMOKE.md
```

## Common Reasons It Looks Like Nothing Works

```text
1. The extension is not installed or not running in Extension Development Host.
2. The current VS Code workspace is not D:\GameDraft, so activation cannot find authoring/project.yaml.
3. The file is outside authoring/** or is not .yaml/.yml/.csv.
4. content_index.json does not exist yet. Run npm run content:build.
5. The YAML file is not saved and the normal pipeline artifacts are stale. Use Refresh Diagnostics or save the file.
6. VS Code language mode is not YAML/CSV. The extension uses file path matching, but YAML syntax services still depend on normal VS Code language mode.
```

## Useful Commands

```text
Game Authoring: Open Planner Dashboard
Game Authoring: Build Content
Game Authoring: Validate Content
Game Authoring: Refresh Diagnostics
Game Authoring: Open Content Report
Game Authoring: Open Content Index
Game Authoring: Open Source Map
Game Authoring: Show Signal Flow
Game Authoring: Show Flag Read/Write
Game Authoring: Show Quest Dependency
Game Authoring: Show Dialogue Route Explain
Game Authoring: Show Runtime Trace Timeline
Game Authoring: Pick Spatial Field (auto-detect)
Game Authoring: Pick Map Position
Game Authoring: Edit Polygon
Game Authoring: Edit Patrol Route
Game Authoring: Pick Spawn Point
Game Authoring: Pick Zone
Game Authoring: Pick Entity
```
