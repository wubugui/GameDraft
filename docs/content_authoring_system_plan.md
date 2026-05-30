# GameDraft Content Authoring System Plan

This document defines the target architecture and implementation plan for the GameDraft content authoring system. It is intended as the long-term roadmap for continuing the branch `codex-content-pipeline-runtime-trace`.

2026-05-30 scope decision:

```text
The production direction is now Graph Authoring Pipeline, not full data-table migration.

Current source-of-truth migration target:
1. dialogue graphs -> YAML
2. narrative graphs / wrapper graphs -> YAML
3. quest logic / dependencies -> YAML
4. flags/signals/quest metadata -> small registry CSV tables

Out of current scope:
1. items/rules/archive/strings/audio/scenes full table migration
2. replacing map/scene editors with CSV
3. forcing ordinary runtime data into authoring tables
```

The system is an authoring/tooling layer for graph content. It compiles the graph YAML files, minimal registry tables, editor operations, validators, visualizers, and simulator results into the existing runtime JSON contract. It must not require the game runtime to understand authoring data.

---

## 1. Core Goal

Build a production-grade graph authoring pipeline for a nonlinear narrative game with many quests, dialogue branches, flags, signals, narrative state machines, and cross-system dependencies.

The system should let creators maintain content through:

- minimal registry tables for flags, signals, and quest metadata;
- YAML DSL for state machines, quests, dialogue flows, and complex graph logic;
- VS Code integration for authoring, validation, navigation, search, references, and graph preview;
- generated visualizations for state machines, dialogue graphs, quest dependencies, signal flows, and flag read/write graphs;
- simulator tooling for checking conditions, signals, quest evaluation, dialogue choices, and state diffs;
- runtime trace tooling for explaining what actually happened during gameplay;
- source maps from runtime JSON / runtime trace events back to authoring files.

The game runtime must continue to consume only the existing JSON formats.

This document may still mention broader table-driven authoring as a historical or future option. Those parts are not active scope unless a later plan explicitly reopens full data migration.

---

## 2. Non-Negotiable Boundary Rules

These rules are architectural constraints and should not be relaxed.

1. Existing runtime JSON is the ABI. It is the only data format the game runtime understands.
2. Existing runtime JSON schema must not be changed for the sake of the authoring system.
3. Existing runtime JSON paths must not be changed for the sake of the authoring system.
4. Existing runtime JSON semantics must not be changed for the sake of the authoring system.
5. Runtime code must not load `authoring/` files.
6. Runtime code must not depend on source maps, graph models, validation reports, or authoring metadata.
7. Authoring-only fields such as `layout`, `tags`, `description`, `source`, `sourceMap`, `debug`, or `__generated` must not be written into runtime JSON unless that field already exists in the runtime contract and has the same runtime meaning.
8. All tool metadata must live under `artifact/content_pipeline/` or another explicit tooling-only location.
9. New DSLs, table formats, visualizers, and simulators are all tool-layer concepts.
10. If the compiler cannot produce valid existing runtime JSON, the compiler is wrong; the runtime should not be modified to compensate.

The correct flow is:

```text
authoring data / tables / DSL / editor tools
        ↓
content pipeline
        ↓
existing runtime JSON
        ↓
existing game runtime
```

The wrong flow is:

```text
authoring data / DSL
        ↓
new runtime logic mixed with old runtime logic
```

---

## 3. Target Repository Layout

Target structure:

```text
authoring/
  project.yaml

  tables/
    flags.csv      # registry only
    signals.csv    # registry only
    quests.csv     # metadata only

  narrative/
    npc/
    case/
    scene/
    system/

  quests/
    main/
    side/
    hidden/

  dialogues/
    npc/
    hotspot/
    system/
    cutscene/

  scenarios/
    main/
    day/
    case/

  simulations/
    narrative/
    quest/
    dialogue/

  templates/
    narrative_npc.yaml
    narrative_case.yaml
    quest_side.yaml
    dialogue_npc.yaml
    dialogue_hotspot.yaml

tools/content_pipeline/
  core/
  schema/
  parser/
  ast/
  compiler/
  validator/
  indexer/
  renderer/
  simulator/
  reporter/
  lsp/
  cli/

tools/vscode-game-authoring/
  src/
    extension.ts
    lspClient.ts
    commands.ts
    treeViews.ts
    webviews/

artifact/content_pipeline/
  runtime_preview/
  content_index.json
  source_map.json
  diagnostics.json
  content_report.md
  graph_models/
  rendered_graphs/
  simulation_results/
  runtime_trace/
```

`public/assets/` remains the runtime data location. During development, the pipeline should default to generating preview JSON under `artifact/content_pipeline/runtime_preview/` unless publishing to runtime output is explicitly enabled.

---

## 4. Authoring Project Config

`authoring/project.yaml` is the root configuration for the authoring system.

It should define:

- whether pipeline output should publish to `public/assets` or only to preview output;
- runtime output paths;
- preview output paths;
- artifact output paths;
- ownership rules for generated files;
- legacy editor coexistence rules;
- strictness settings for validation;
- enabled feature modules.

Example:

```yaml
publishRuntime: false

runtimeOutputs:
  flagRegistry: public/assets/data/flag_registry.json
  narrativeGraphs: public/assets/data/narrative_graphs.json
  quests: public/assets/data/quests.json
  dialogueGraphs: public/assets/dialogues/graphs

previewOutputs:
  flagRegistry: artifact/content_pipeline/runtime_preview/public/assets/data/flag_registry.json
  narrativeGraphs: artifact/content_pipeline/runtime_preview/public/assets/data/narrative_graphs.json
  quests: artifact/content_pipeline/runtime_preview/public/assets/data/quests.json
  dialogueGraphs: artifact/content_pipeline/runtime_preview/public/assets/dialogues/graphs

artifacts:
  root: artifact/content_pipeline
  sourceMap: artifact/content_pipeline/source_map.json
  contentIndex: artifact/content_pipeline/content_index.json
  report: artifact/content_pipeline/content_report.md
  graphModels: artifact/content_pipeline/graph_models
  renderedGraphs: artifact/content_pipeline/rendered_graphs

ownership:
  public/assets/data/flag_registry.json: pipeline
  public/assets/data/narrative_graphs.json: pipeline
  public/assets/data/quests.json: pipeline
  public/assets/dialogues/graphs/dsl_*: pipeline
  public/assets/dialogues/graphs/legacy_*: legacy_editor
```

Ownership is important. The old editor, hand-authored JSON, and new pipeline must not write the same runtime file without an explicit ownership rule.

---

## 5. Data Categories

The graph authoring system should separate content into three categories.

### 5.1 Registry / Metadata Tables

Use tables only for small registries and metadata that support graph authoring.

Current active tables:

- flags;
- signals;
- quest base metadata.

Tables should support:

- required columns;
- enum validation;
- duplicate ID checks;
- reference validation;
- hover docs in VS Code;
- definition/reference navigation;
- stable generated JSON where the pipeline owns the output.

Out of current scope:

- items;
- rules;
- rule fragments;
- archive entries;
- UI strings;
- NPC base data;
- audio registry;
- scene registry.

These remain in the existing runtime/editor workflow. The graph pipeline may index references to them for diagnostics, but it does not migrate them into tables.

### 5.2 Structured Logic Data

Use YAML DSL. These have nested logic, branching, conditions, actions, and state transitions.

Examples:

- narrative state machines;
- quest logic;
- dialogue graphs;
- scenario phase logic;
- cutscene/action sequences;
- scene/hotspot condition logic if necessary.

### 5.3 Runtime JSON

This is generated output or legacy input. It must remain exactly compatible with the current runtime.

Runtime JSON should be treated as generated ABI, not as the preferred authoring source.

---

## 6. Minimal Registry Table System

Tables are CSV files in this repository. They are intentionally minimal. Do not add new data tables just because a runtime JSON file exists.

If the project later needs Sheet/Excel/Airtable integration, it should export into these same minimal CSV registries or into a separately approved table format.

### 6.1 `flags.csv`

Purpose: declare all known flags, types, owners, meanings, defaults, and notes.

Suggested columns:

```csv
key,type,owner,meaning,default,notes
case.bridge.heard_warning,bool,case.bridge,玩家听过桥雾警告,false,
```

Validation:

- `key` must be unique;
- `type` must be one of supported flag types;
- `owner` should be namespaced;
- unknown flag readers/writers should warn or error depending on strictness;
- multiple writers across owners should warn.

Runtime output:

- existing `flag_registry.json` shape only.

Tool artifacts:

- flag readers/writers index;
- flag declaration metadata;
- ownership diagnostics.

### 6.2 `signals.csv`

Purpose: declare semantic events used by narrative transitions and action emitters.

Suggested columns:

```csv
key,owner,meaning,notes
old_zhou.told_bridge_warning,npc.old_zhou,老周说出桥雾警告,
```

Validation:

- `key` must be unique;
- emitters/listeners should be indexed;
- signal with emitter but no listener should warn;
- signal with listener but no emitter should warn;
- signal naming should prefer event semantics, not state semantics.

Runtime output:

- usually none, unless the existing runtime already has a signal registry format.

Tool artifacts:

- signal declaration metadata;
- signal flow graph;
- emitters/listeners index.

### 6.3 `quests.csv`

Purpose: declare quest base metadata.

Suggested columns:

```csv
id,group,type,sideType,title,description,notes
bridge_find_source,bridge_case,side,investigation,查清桥雾来历,老周提醒你夜里不要过桥。,
```

Quest logic should not be forced into table columns. Complex logic should live in quest YAML files.

---

## 7. Narrative State Machine DSL

Narrative DSL defines state machines for NPCs, cases, scenes, systems, or other narrative owners.

Example:

```yaml
id: npc.old_zhou
kind: narrativeGraph
owner:
  type: npc
  id: old_zhou
initialState: stranger
states:
  stranger:
    label: 陌生
    description: 玩家尚未获得老周信任
  cautious:
    label: 警惕
  helpful:
    label: 愿意帮忙
    broadcastOnEnter: true
    onEnterActions:
      - type: setFlag
        params:
          key: npc.old_zhou.helpful
          value: true
transitions:
  - id: hear_bridge_warning
    from: stranger
    to: cautious
    signal: old_zhou.told_bridge_warning
  - id: show_paper_charm
    from: cautious
    to: helpful
    signal: player.showed_paper_charm
    priority: 10
    conditions:
      - all:
          - flag: case.bridge.has_paper_charm
            op: ==
            value: true
layout:
  stranger: { x: 0, y: 0 }
  cautious: { x: 320, y: 0 }
  helpful: { x: 640, y: 0 }
```

Runtime compilation rules:

- compile only fields that exist in the existing runtime narrative graph contract;
- do not emit `label`, `description`, `layout`, or `tags` into runtime JSON unless already supported by runtime semantics;
- extra authoring metadata goes to graph model artifacts and source map files.

Validation:

- graph ID required;
- owner type/id required where applicable;
- initial state must exist;
- transition `from` and `to` must exist;
- transition IDs should be unique within a graph;
- signals should be declared;
- conditions should reference known flags/quests/narrative states;
- onEnter/onExit actions should be valid action definitions;
- unreachable states should warn;
- impossible transitions should warn when statically detectable.

Visualization:

- state nodes;
- transition edges;
- signal labels;
- condition badges;
- onEnter/onExit action badges;
- broadcastOnEnter badges;
- current runtime state overlay from debug trace/snapshot later.

---

## 8. Quest DSL

Quest authoring is split into base metadata table and logic YAML.

`quests.csv` owns stable display fields. Quest YAML owns logic.

Example:

```yaml
id: bridge_find_source
preconditions:
  - all:
      - flag: case.bridge.heard_warning
        op: ==
        value: true
completionConditions:
  - all:
      - narrative: case.bridge
        state: source_found
acceptActions:
  - type: showNotification
    params:
      text: 新的线索：桥雾的来历
      type: quest
rewards:
  - type: emitNarrativeSignal
    params:
      signal: quest.bridge_find_source.completed
nextQuests:
  - questId: bridge_find_countermeasure
    conditions:
      - all:
          - flag: case.bridge.has_paper_charm
            op: ==
            value: true
```

Runtime compilation rules:

- merge table metadata and YAML logic;
- generate existing `quests.json` shape;
- do not change QuestManager semantics.

Validation:

- quest ID must exist in table or YAML according to project rules;
- duplicate quest IDs are errors;
- referenced next quests must exist;
- preconditions and completion conditions must be valid conditions;
- reward and accept actions must be valid action definitions;
- quest dependency cycles should be detected and reported;
- quests with no activation path should warn;
- rewards that write many global flags should warn.

Visualization:

- quest precondition dependencies;
- completion dependencies;
- next quest graph;
- reward effects;
- flag/signal/narrative state influence graph.

---

## 9. Dialogue DSL

Dialogue DSL should cover the current graph dialogue runtime node types.

Core node types:

- line;
- choice;
- switch;
- runActions;
- ownerState/contextState if still used by runtime;
- end.

Example:

```yaml
id: old_zhou_intro
kind: dialogueGraph
entry: start
nodes:
  start:
    type: line
    speaker:
      kind: npc
    text: 你不是本地人吧？
    next: ask
  ask:
    type: choice
    promptLine:
      speaker:
        kind: player
      text: 我想问点事。
    options:
      - id: ask_bridge
        text: 桥上的雾是怎么回事？
        next: bridge_warning
      - id: leave
        text: 没事了。
        next: end
  bridge_warning:
    type: line
    speaker:
      kind: npc
    text: 那桥，夜里别走。
    next: bridge_actions
  bridge_actions:
    type: runActions
    actions:
      - type: setFlag
        params:
          key: case.bridge.heard_warning
          value: true
      - type: emitNarrativeSignal
        params:
          signal: old_zhou.told_bridge_warning
    next: end
  end:
    type: end
```

Runtime compilation rules:

- generate existing dialogue graph JSON shape;
- generated dialogue JSON must be runnable by the existing GraphDialogueManager;
- do not require runtime to understand DSL-specific shortcuts.

Validation:

- graph ID required;
- entry node must exist;
- every `next` must point to an existing node;
- every choice option target must exist;
- every switch case target/default target must exist;
- graph should have at least one reachable end or explicit non-ending behavior;
- actions must be valid;
- condition references must be valid;
- unreachable nodes should warn.

Visualization:

- flow graph of line/choice/switch/action/end nodes;
- action effect badges;
- flag readers/writers;
- signal emitters;
- quest effects;
- route preview under a simulated state.

---

## 10. Canonical AST

The pipeline should not let every subsystem parse YAML/CSV independently.

Target flow:

```text
CSV / YAML / legacy import / editor operations
        ↓
parser
        ↓
canonical AST
        ↓
compiler / validator / indexer / renderer / simulator
```

Core AST objects:

- AuthoringProject;
- FlagRegistryModel;
- SignalRegistryModel;
- NarrativeGraphModel;
- NarrativeStateModel;
- NarrativeTransitionModel;
- QuestModel;
- DialogueGraphModel;
- DialogueNodeModel;
- ActionModel;
- ConditionModel.

Each AST node should carry:

- stable ID;
- authoring file path;
- line/column where possible;
- authoring path;
- runtime target path when compiled;
- owner namespace;
- tags if any;
- source map symbol.

---

## 11. Compiler

The compiler is the only system that converts authoring data into runtime JSON.

Compiler modules:

```text
tools/content_pipeline/compiler/
  compile_flags.py
  compile_signals.py
  compile_narrative.py
  compile_quests.py
  compile_dialogues.py
  compile_scenarios.py
  compile_tables.py
  compile_all.py
```

Compiler requirements:

1. output existing runtime JSON only;
2. preserve field names and semantics;
3. handle default values consistently with runtime expectations;
4. write preview output by default;
5. publish to runtime output only when explicitly enabled;
6. generate source map entries for every compiled object;
7. generate diagnostics for invalid or lossy compilation;
8. never silently drop meaningful content.

---

## 12. Validators

Validation should be a first-class system, not a late script.

Validator categories:

### 12.1 Schema Validator

Checks authoring file shape:

- required fields;
- field types;
- enum values;
- CSV required columns;
- invalid YAML structures;
- invalid action shapes;
- invalid condition shapes.

### 12.2 Reference Validator

Checks cross-content references:

- flag exists;
- signal exists;
- quest exists;
- narrative graph exists;
- narrative state exists;
- dialogue graph exists;
- dialogue node exists;
- action type exists;
- item/rule/NPC/scene/audio exists when referenced.

### 12.3 Semantic Validator

Checks design risks:

- signal emitted but not listened to;
- signal listened to but not emitted;
- flag read but never written;
- flag written but never read;
- multiple unrelated owners writing the same flag;
- unreachable state;
- unreachable dialogue node;
- quest dependency cycle;
- quest with no activation path;
- switch node without default path;
- graph with no ending path;
- transition that can never fire under static constraints.

### 12.4 Ownership Validator

Checks authoring pipeline and legacy editor coexistence:

- pipeline must not overwrite legacy-owned files;
- legacy editor should not edit pipeline-owned output;
- duplicate runtime IDs across legacy and pipeline output should be errors;
- generated preview and runtime publish paths should be consistent.

### 12.5 Compatibility Validator

After compilation, generated runtime JSON must be validated against the existing runtime contract.

This should reuse existing TypeScript/runtime validators where possible. If tooling-side validation is written in Python, it must mirror the current schema exactly and be treated as a compatibility layer, not a new runtime schema.

---

## 13. Content Index

The content index is the global reference database for tools.

Output:

```text
artifact/content_pipeline/content_index.json
```

Index categories:

- flags;
- signals;
- quests;
- narrative graphs;
- narrative states;
- dialogue graphs;
- dialogue nodes;
- actions;
- conditions;
- items/rules/scenes/NPCs where applicable.

For each item, the index should record:

- declarations;
- readers;
- writers;
- emitters;
- listeners;
- dependencies;
- effects;
- owner;
- authoring source location;
- runtime target location.

Example shape:

```json
{
  "flags": {
    "case.bridge.heard_warning": {
      "declaredAt": [],
      "readers": [],
      "writers": []
    }
  },
  "signals": {
    "old_zhou.told_bridge_warning": {
      "declaredAt": [],
      "emitters": [],
      "listeners": []
    }
  }
}
```

The index powers:

- VS Code hover;
- go to definition;
- find references;
- graph visualization;
- validation;
- simulator explanations;
- debug trace source lookup.

---

## 14. Source Map

Source map links runtime JSON and runtime events back to authoring files.

Output:

```text
artifact/content_pipeline/source_map.json
```

It should support mapping for:

- flag declarations;
- signal declarations;
- quest definitions;
- quest conditions;
- quest actions;
- narrative graphs;
- narrative states;
- narrative transitions;
- dialogue graphs;
- dialogue nodes;
- dialogue options;
- dialogue actions;
- conditions;
- actions.

Example:

```json
{
  "runtime://public/assets/data/narrative_graphs.json#/graphs/0/transitions/1": {
    "authoringFile": "authoring/narrative/npc/old_zhou.yaml",
    "line": 24,
    "column": 5,
    "symbol": "narrative:npc.old_zhou.transition.show_paper_charm"
  }
}
```

Runtime code does not use source maps for gameplay. Source maps are for tools, VS Code, debug trace panels, and diagnostics.

---

## 15. Visualization System

Visualization must be generated from compiled models or graph models, not manually maintained as a separate truth.

Outputs:

```text
artifact/content_pipeline/graph_models/
artifact/content_pipeline/rendered_graphs/
```

Target graph types:

### 15.1 Narrative State Graph

Displays:

- state nodes;
- transition edges;
- signal labels;
- condition badges;
- onEnter/onExit badges;
- broadcastOnEnter badges;
- current runtime state overlay later.

### 15.2 Dialogue Flow Graph

Displays:

- line nodes;
- choice nodes;
- switch nodes;
- runActions nodes;
- end nodes;
- action effect badges;
- condition gates;
- route previews.

### 15.3 Quest Dependency Graph

Displays:

- precondition dependencies;
- completion dependencies;
- next quest links;
- reward effects;
- signal and flag impacts.

### 15.4 Signal Flow Graph

Displays:

```text
emitters → signal → listeners
```

This is essential for nonlinear content debugging.

### 15.5 Flag Read/Write Graph

Displays:

```text
writers → flag → readers
```

This is essential for avoiding global variable sprawl.

Implementation stages:

1. generate Mermaid text;
2. generate graph model JSON;
3. render in VS Code Webview with React Flow or Cytoscape;
4. overlay simulator/runtime state.

---

## 16. Tool-Side Condition Eval Engine

The simulator needs a tool-side evaluator for the existing `ConditionExpr` semantics.

It must not invent a second runtime condition language.

It should evaluate the same condition shape used by runtime JSON:

- flag conditions;
- quest conditions;
- narrative state conditions;
- scenario conditions;
- all/any/not composition;
- comparison operators supported by runtime.

Input simulation state:

```yaml
flags:
  case.bridge.heard_warning: true
  case.bridge.has_paper_charm: false
quests:
  bridge_find_source: Active
narrative:
  npc.old_zhou: cautious
  case.bridge: investigating
scenario:
  day1.bridge_intro:
    status: done
```

Evaluator output should include trace details:

- final true/false;
- tree of evaluated subconditions;
- expected value;
- actual value;
- missing references;
- source map symbol.

---

## 17. Simulator

Simulator allows creators to test narrative logic without manually playing through every branch.

Simulation capabilities:

- evaluate a condition;
- simulate setting a flag;
- simulate emitting a signal;
- simulate choosing a dialogue option;
- simulate entering a dialogue graph;
- simulate quest evaluation after a state change;
- simulate narrative transition processing;
- show before/after diff;
- show blocked transitions and reasons;
- show activated/completed quests;
- show emitted signals;
- show action effects.

Example output:

```json
{
  "input": {
    "type": "emitSignal",
    "signal": "player.showed_paper_charm"
  },
  "changes": {
    "narrative": [
      {
        "graphId": "npc.old_zhou",
        "from": "cautious",
        "to": "helpful",
        "transitionId": "show_paper_charm"
      }
    ],
    "flags": [],
    "quests": []
  },
  "blocked": [
    {
      "kind": "transition",
      "id": "case.bridge.resolve",
      "reason": "flag case.bridge.has_paper_charm expected true, actual false"
    }
  ]
}
```

Simulator output should be usable by VS Code Webviews and command-line reports.

---

## 18. Runtime Trace Bridge

Runtime trace explains what actually happened in the game.

Trace is not part of gameplay logic. It is a debug observation layer.

Trace events should include:

- dialogue start;
- dialogue node entered;
- dialogue choice selected;
- dialogue ended;
- action start/end/fail;
- flag changed;
- quest accepted/completed/evaluated;
- signal emitted;
- narrative transition candidate matched/blocked/applied;
- narrative state changed;
- scenario changed;
- scene changed.

Trace event shape:

```ts
interface RuntimeTraceEvent {
  id: number;
  timeMs: number;
  type: 'dialogue' | 'action' | 'flag' | 'quest' | 'signal' | 'narrative' | 'scenario' | 'scene' | 'system';
  phase?: 'start' | 'end' | 'fail' | 'change' | 'emit' | 'match' | 'block' | 'info';
  label: string;
  causeId?: number;
  payload?: Record<string, unknown>;
}
```

Runtime trace should be visible in:

- F2 debug panel;
- browser dev tools via `window.__GAME_RUNTIME_TRACE__`;
- exported artifact files;
- VS Code runtime trace view later.

The long-term goal is:

```text
runtime trace event
        ↓
runtime symbol
        ↓
source_map.json
        ↓
authoring file/line
        ↓
VS Code opens source and graph view highlights related node/edge
```

---

## 19. VS Code Extension

VS Code should be treated as the primary authoring IDE, not just an optional editor.

The extension should provide:

- content build command;
- validate command;
- render command;
- open content report;
- open content index;
- open source map;
- open graph previews;
- open reference panels;
- simulator panels;
- runtime trace help/panel;
- optional LSP client.

Target commands:

```text
Game Authoring: Build Content
Game Authoring: Validate Content
Game Authoring: Render Graphs
Game Authoring: Watch Content
Game Authoring: Open Content Report
Game Authoring: Open Content Index
Game Authoring: Open Source Map
Game Authoring: Preview Narrative Graph
Game Authoring: Preview Dialogue Graph
Game Authoring: Show Quest Dependencies
Game Authoring: Show Signal Flow
Game Authoring: Show Flag References
Game Authoring: Simulate Current File
Game Authoring: Runtime Trace Help
Game Authoring: Open Runtime Trace
```

---

## 20. Language Server

The LSP should expose authoring intelligence inside VS Code.

Capabilities:

- diagnostics;
- completion;
- hover;
- go to definition;
- find references;
- rename symbol;
- document symbols;
- workspace symbols;
- code actions;
- semantic tokens.

### 20.1 Diagnostics

Diagnostics should show:

- unknown flag;
- unknown signal;
- missing narrative state;
- missing dialogue node target;
- duplicate ID;
- invalid action type;
- invalid condition shape;
- ownership conflict.

### 20.2 Completion

Completion targets:

- flag keys;
- signal keys;
- quest IDs;
- narrative graph IDs;
- narrative state IDs based on graph;
- dialogue graph IDs;
- dialogue node IDs;
- action types;
- item IDs;
- rule IDs;
- scene IDs;
- NPC IDs;
- audio IDs.

### 20.3 Hover

Hover should summarize:

- owner;
- type;
- meaning;
- declaration location;
- readers/writers;
- emitters/listeners;
- warnings.

### 20.4 Definition and References

Definition should jump to the declaration table or YAML source.

References should show all reads/writes/emits/listens/dependencies from `content_index.json`.

### 20.5 Code Actions

Potential code actions:

- create missing flag;
- create missing signal;
- create missing state;
- create missing dialogue node;
- create missing quest stub;
- convert inline repeated condition to registered flag or named condition later.

---

## 21. VS Code Webviews

Webviews should use generated graph model JSON and content index artifacts.

Target webviews:

### 21.1 Narrative Graph View

Features:

- graph list;
- state graph;
- transition inspector;
- condition inspector;
- action badges;
- source jump;
- warning display;
- simulator overlay later.

### 21.2 Dialogue Graph View

Features:

- node graph;
- choice preview;
- switch branch preview;
- runActions effect summary;
- source jump;
- route simulation.

### 21.3 Quest Graph View

Features:

- quest dependency graph;
- precondition/completion dependency list;
- reward effect summary;
- nextQuest graph;
- cycle warnings.

### 21.4 References View

Features:

- search flag/signal/quest/state/action;
- readers/writers;
- emitters/listeners;
- click to source;
- click to graph.

### 21.5 Simulator View

Features:

- select snapshot;
- edit mock flags;
- edit quest states;
- edit narrative states;
- emit signal;
- run action chain;
- show diff;
- show blocked reasons;
- highlight graph edges.

### 21.6 Runtime Trace View

Features:

- timeline;
- filtering by event type;
- source map jump;
- graph highlight;
- copy/export trace.

---

## 22. CLI Commands

Target commands:

```powershell
python -m tools.content_pipeline build
python -m tools.content_pipeline validate
python -m tools.content_pipeline index
python -m tools.content_pipeline render
python -m tools.content_pipeline simulate authoring/simulations/case.yaml
python -m tools.content_pipeline watch
python -m tools.content_pipeline new narrative npc.old_zhou --owner npc:old_zhou
python -m tools.content_pipeline new quest bridge_find_source
python -m tools.content_pipeline new dialogue old_zhou_intro --npc old_zhou
python -m tools.content_pipeline publish
python -m tools.content_pipeline clean
```

`build` should:

1. load project config;
2. parse tables and DSL;
3. build canonical AST;
4. validate schema/reference/semantic rules;
5. compile preview JSON;
6. run compatibility validation;
7. build content index;
8. build source map;
9. render graph models;
10. write report.

`publish` should be explicit and should refuse to overwrite runtime-owned files unless ownership allows it.

---

## 23. Runtime JSON Compatibility

Every generated runtime JSON file must pass compatibility checks before publish.

Compatibility checks should ensure:

- no authoring-only fields;
- required runtime fields exist;
- field names match current runtime contract;
- arrays/objects match expected shape;
- action definitions match runtime shape;
- condition expressions match runtime shape;
- dialogue graph can be loaded by existing GraphDialogueManager;
- quest definitions can be loaded by existing QuestManager;
- narrative graphs can be loaded by existing NarrativeStateManager.

If there is a mismatch, the fix belongs in the pipeline compiler unless the current runtime contract is already broken independently of the pipeline.

---

## 24. CI and Review Workflow

The future CI should run:

```powershell
npm run content:build
npm run content:validate
npm run test
npm run build
```

CI should fail on:

- schema errors;
- compatibility errors;
- ownership conflicts;
- duplicate IDs;
- missing required references;
- invalid runtime output.

CI may allow warnings temporarily, but warnings should be visible in artifacts.

Generated reports:

- content report markdown;
- diagnostics JSON;
- compatibility report;
- content index;
- rendered graphs if useful as artifacts.

---

## 25. Implementation Order

The recommended implementation order is:

1. Solidify project config and ownership rules.
2. Replace the lightweight YAML subset parser with a full YAML parser in tooling environment.
3. Split current monolithic pipeline into parser / AST / compiler / validator / indexer / renderer modules.
4. Keep only minimal registry table schemas for flags, signals, and quest metadata.
5. Implement complete narrative DSL parser/compiler/validator/source map.
6. Implement complete quest YAML compiler/validator/source map.
7. Implement complete dialogue YAML compiler/validator/source map.
8. Implement compatibility validator against existing runtime JSON contracts.
9. Implement complete content index and reference scanner.
10. Implement graph model outputs for narrative, dialogue, quest, signal, and flag graphs.
11. Implement tool-side ConditionExpr evaluator with trace output.
12. Implement simulator for signal, setFlag, quest evaluation, and dialogue route preview.
13. Implement VS Code LSP diagnostics/completion/hover/definition/references.
14. Implement VS Code webviews for graphs and references.
15. Expand runtime trace to include candidate transition match/block and quest evaluation details.
16. Connect runtime trace to source map and VS Code source jump.
17. Add CI and publish workflow.
18. Gradually migrate real graph content from legacy JSON/editor output into authoring YAML.

---

## 26. Migration Strategy

The old editor and graph authoring pipeline should coexist during migration.

Rules:

- each runtime output file must have a clear owner;
- pipeline-owned files should be generated, not hand edited;
- legacy-owned files should not be overwritten by the pipeline;
- duplicate runtime IDs across legacy and pipeline output should be errors;
- graph migration should happen by closed content batch, not randomly file by file.

Suggested migration order:

1. keep flags/signals/quest metadata registries current;
2. migrate narrative state machines;
3. migrate dialogue graphs;
4. migrate quest logic and dependency wrappers;
5. keep ordinary runtime data such as items/rules/archive/strings/audio/scenes in the existing workflow unless a separate production need appears.

---

## 27. Naming and Ownership Conventions

Strong naming rules are required for nonlinear content.

Recommended namespaces:

```text
case.bridge.heard_warning
npc.old_zhou.helpful
quest.bridge_find_source.completed
scene.old_bridge.fog_active
signal old_zhou.told_bridge_warning
```

Rules:

- flags should represent facts, not vague process steps;
- signals should represent events, not states;
- each long-term fact should have one source of truth;
- every flag/signal should have an owner;
- cross-owner writes should be warnings unless explicitly allowed;
- quest state should live in QuestManager, not in flags unless runtime requires otherwise;
- narrative state should live in NarrativeStateManager, not duplicated as flags unless deliberately projected.

---

## 28. Final Target Experience

A creator should be able to:

1. edit CSV tables and YAML DSL in VS Code;
2. get red squiggles for invalid flags, signals, states, nodes, actions, and quests;
3. use completion for known IDs;
4. hover to see meanings and references;
5. Ctrl-click to definitions;
6. find all references for a flag/signal/state/quest;
7. preview state machine/dialogue/quest graphs;
8. simulate a signal or dialogue choice;
9. see why a transition or quest is blocked;
10. run the game and open F2 timeline;
11. trace actual runtime events back to DSL/table source;
12. build/publish existing runtime JSON without changing runtime code.

That is the final product: a data-first, tool-heavy authoring system that generates the existing runtime JSON contract and gives creators enough visibility to maintain nonlinear content at scale.
