# Content Authoring Pipeline

This branch adds a tooling-only authoring pipeline. Runtime JSON is treated as an immutable contract.

## Boundary

- Runtime code does not load the authoring folder.
- Runtime JSON schemas are not extended.
- Tool metadata is written under artifact/content_pipeline.
- Generated JSON goes to artifact/content_pipeline/runtime_preview by default.

## Commands

Run:

    npm run content:build
    npm run content:validate
    npm run content:index
    npm run content:render
    npm run content:simulate
    npm run content:watch

Direct CLI:

    .\.tools\Python311\python.exe -m tools.content_pipeline build

## Inputs

- authoring/tables/flags.csv
- authoring/tables/signals.csv
- authoring/tables/quests.csv
- authoring/narrative/**/*.yaml
- authoring/quests/**/*.yaml
- authoring/dialogues/**/*.yaml

## Outputs

- artifact/content_pipeline/runtime_preview
- artifact/content_pipeline/content_index.json
- artifact/content_pipeline/source_map.json
- artifact/content_pipeline/content_report.md
- artifact/content_pipeline/rendered_graphs

## VS Code

A VS Code extension skeleton lives in tools/vscode-game-authoring. It provides commands for build, validate, and opening the report. An optional LSP placeholder is in tools/content_pipeline/lsp_server.py.
