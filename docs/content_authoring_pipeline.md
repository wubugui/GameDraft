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
    npm run content:explain
    npm run content:trace-resolve -- artifact/content_pipeline/runtime_trace/sample.json
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
- artifact/content_pipeline/runtime_debug_map.json
- artifact/content_pipeline/content_report.md
- artifact/content_pipeline/rendered_graphs
- artifact/content_pipeline/condition_explain.json
- artifact/content_pipeline/runtime_trace/resolved_trace.json

## Debug Trace

The compiler writes sidecar-only debug maps under `artifact/content_pipeline/`. Runtime JSON stays clean: authoring `id` fields used for source mapping are stripped from generated runtime preview JSON.

`source_map.json` / `runtime_debug_map.json` use `sourceId` and `runtimeRef`:

```json
{
  "version": 2,
  "sources": {
    "dialogue.sample_intro.node.action_node.action.warn_flag": {
      "kind": "action",
      "file": "authoring/dialogues/npc/sample_intro.yaml",
      "line": 21,
      "column": 9
    }
  },
  "runtimeToSource": {
    "dialogue:sample_intro.node:action_node.actions[0]": "dialogue.sample_intro.node.action_node.action.warn_flag"
  }
}
```

Runtime traces can be exported as an event array, then resolved back to authoring sources:

    .\.tools\Python311\python.exe -m tools.content_pipeline trace-resolve path\to\trace.json

Condition simulation reads compiled runtime preview JSON and uses the TypeScript runtime evaluator via `tsx`. It accepts an optional JSON state file:

    .\.tools\Python311\python.exe -m tools.content_pipeline explain path\to\state.json

State shape:

```json
{
  "flags": { "case.bridge.heard_warning": true },
  "quests": { "bridge_find_source": "Active" },
  "scenarios": { "case.bridge": { "phase_a": { "status": "completed", "outcome": null } } },
  "scenarioLines": { "line.case.bridge_intro": "completed" },
  "narrative": { "case.bridge": "source_found" },
  "literals": {}
}
```

## VS Code

A VS Code extension skeleton lives in tools/vscode-game-authoring. It provides commands for build, validate, and opening the report. An optional LSP placeholder is in tools/content_pipeline/lsp_server.py.
