# Graph Authoring Pipeline

This branch adds a tooling-only graph authoring pipeline. Runtime JSON is treated as an immutable contract.

The current production scope is intentionally narrow:

- dialogue graphs, narrative graphs, and quest logic are authored in YAML;
- `flags.csv`, `signals.csv`, and `quests.csv` are small registry/metadata tables used for validation, completion, and trace readability;
- normal runtime data such as items, rules, archive entries, strings, audio, scenes, entities, zones, and routes stays in the existing runtime/editor workflow unless a separate migration is explicitly approved.

This is **not** a full data-table migration pipeline.

## Boundary

- Runtime code does not load the authoring folder.
- Runtime JSON schemas are not extended.
- Tool metadata is written under artifact/content_pipeline.
- Generated JSON goes to artifact/content_pipeline/runtime_preview by default.
- `public/assets/**` remains the runtime contract and is not hand-edited when a path is pipeline-owned.
- The pipeline owns graph authoring outputs only where ownership says it may publish.

## Authoring Source Rules

Use these rules when deciding where content belongs:

- Put dialogue route logic in `authoring/dialogues/**/*.yaml`.
- Put narrative state machines and wrapper graphs in `authoring/narrative/**/*.yaml`.
- Put quest structure, conditions, rewards, and dependencies in `authoring/quests/**/*.yaml`.
- Put only registry/metadata rows in `authoring/tables/flags.csv`, `authoring/tables/signals.csv`, and `authoring/tables/quests.csv`.
- Do not add new CSV tables for items/rules/archive/strings/audio/scenes unless the project explicitly changes scope.
- Do not move map geometry, polygon editing, patrol routes, or entity placement into CSV just to use the pipeline.

## Commands

Each command writes a distinct subset of artifacts:

- `build` — compile + write runtime preview JSON, renders, index, source map, report.
- `validate` — compile + print diagnostics only; writes nothing to disk.
- `diagnostics-json` — compile + print machine-readable diagnostics for tools/LSP.
- `index` — write only `content_index.json`.
- `render` — write only the mermaid graph renders.

Run:

    npm run content:build
    npm run content:validate
    npm run content:diagnostics-json
    npm run content:index
    npm run content:render
    npm run content:simulate
    npm run content:explain
    npm run content:lsp-smoke
    npm run content:check
    npm run content:trace-resolve -- artifact/content_pipeline/runtime_trace/sample.json
    npm run content:watch

Direct CLI:

    .\.tools\Python311\python.exe -m tools.content_pipeline build

## Publishing to real runtime paths

By default everything is written to the preview tree. `build --publish` writes
each output to its real `runtimeOutputs` path **only when that path is not owned
by `legacy_editor`** in `authoring/project.yaml`'s `ownership` map. Files owned by
the legacy editor are always kept in preview, so publishing can never clobber
editor-authored runtime JSON:

    .\.tools\Python311\python.exe -m tools.content_pipeline build --publish

`project.yaml` is parsed for `publishRuntime`, `runtimeOutputs`, `previewOutputs`
and `ownership`; missing keys fall back to safe defaults.

## Inputs

- authoring/tables/flags.csv — flag registry only.
- authoring/tables/signals.csv — signal registry only.
- authoring/tables/quests.csv — quest metadata only.
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
- artifact/content_pipeline/simulation_result.json
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

Condition explanation reads compiled runtime preview JSON and uses the TypeScript runtime evaluator via `tsx`. It accepts an optional JSON state file:

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

Runtime simulation uses the same state shape and adds an optional `simulate` block.
It writes `artifact/content_pipeline/simulation_result.json` with `initialState`,
`finalState`, `diff`, `events`, `route`, `blocked`, and condition traces resolved
back to authoring source locations.

Dialogue route preview:

```json
{
  "flags": {},
  "quests": {},
  "scenarios": {},
  "scenarioLines": {},
  "narrative": {},
  "literals": {},
  "simulate": {
    "type": "dialogueRoute",
    "graphId": "sample_intro",
    "choices": { "ask": "continue" },
    "owner": { "type": "npc", "id": "old_zhou" },
    "maxSteps": 100
  }
}
```

Other supported simulation entries:

```json
{ "simulate": { "type": "emitSignal", "signal": "old_zhou.told_bridge_warning" } }
{ "simulate": { "type": "actions", "actions": [{ "type": "setFlag", "params": { "key": "x", "value": true } }] } }
```

Simulation currently applies the high-value runtime mutations used by narrative
authoring: flags, emitted narrative signals, narrative transitions including
reactive transitions, quest accept/complete/next quest evaluation, dialogue
line/choice/switch/runActions/ownerState/contextState routing, scenario
lifecycle actions, inventory/currency deltas, scene switches, and entity
position writes. Unsupported actions are still recorded as events so authored
paths remain auditable.

## Validation

The compiler validates both topology and parameter shape. It catches duplicate
ids, missing dialogue targets, unreachable/dead-end dialogue nodes, undeclared
flags/signals/quests/graphs/states/scenes, flag read/write asymmetry, action
required params, action numeric params, `setFlag` value type mismatches against
`flags.csv`, `appendFlag` type misuse, quest/scenario status enums, and invalid
ordered comparisons against non-numeric flags.

Reference checks for items/rules/archive/audio/scenes are graph-authoring checks.
They do not imply those runtime data files have been migrated to authoring CSV.

## VS Code

A VS Code extension lives in tools/vscode-game-authoring. It provides build,
diagnostics refresh, report opening, map position picking, completion, hover,
definition, and references. The extension starts the stdio LSP server in
tools/content_pipeline/lsp_server.py for YAML/CSV authoring diagnostics and
language features.
