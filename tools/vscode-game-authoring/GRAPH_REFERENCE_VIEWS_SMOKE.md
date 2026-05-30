# Graph / Reference Views Smoke

Use these steps after running `npm run content:build` and `npm run content:simulate`.

## Commands

Open the VS Code command palette and verify:

```text
Game Authoring: Open Graph / Reference View
Game Authoring: Show Signal Flow
Game Authoring: Show Flag Read/Write
Game Authoring: Show Quest Dependency
Game Authoring: Show Dialogue Route Explain
Game Authoring: Show Runtime Trace Timeline
```

## Expected Behavior

```text
1. Signal Flow shows declaration, emitters, listeners, and derived state broadcast source for state:* signals.
2. Flag Read/Write shows registry declaration, readers, writers, and registry value type.
3. Quest Dependency shows declaration, readers, writers, preconditions, completion conditions, actions, rewards, and next quest edges.
4. Dialogue Route Explain shows route steps, choice selections, condition traces, and action events from simulation_result.json.
5. Runtime Trace Timeline shows events, blocked reasons, diagnostics, and final diff from simulation_result.json.
6. Open Source buttons jump to the source file and line when source mapping is available.
7. Views are read-only; there is no graph editing or write-back path.
```

