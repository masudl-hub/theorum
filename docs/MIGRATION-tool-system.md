# Tool system migration

Ground-up tool registry rebuild (2026). **No compatibility shims.** Hosts must
migrate once; after that the model is simpler and enforcement is consistent.

Spec: `docs/specs/tool-system.md`

---

## Breaking API removals

| Removed | Replacement |
| --- | --- |
| `TurnRequest.dynamicTools` | `registerTool({ ... })` at startup |
| `TurnRequest.dynamicToolLoader` | `type: 'loader'` tool with `resolve()` |
| `TurnRequest.toolInvoke` | `invokeTool({ profile, name, input, … })` |
| `executeTool(profile, name, args)` | Stream events via `runTurn` / `invokeTool` |
| `ToolEnvelope` (`status` / `finding` / `data`) | `TurnEvent.tool.phase` (`complete`, `pause`, `error`, …) |
| `askUser` catalog builtin | `ask_user` harness tool (`registerHarnessTools`) |
| Per-turn `loadTier` / `permissionTier` on declarations | `loadTier` / `permission` on `defineTool` |
| Per-turn `dynamicToolLoader` (T2 schemas) | `type: 'loader'` tool with `resolve()` |
| Per-turn T1 conditional wiring | `TurnRequest.toolLoader` |
| Hand-authored JSON Schema on turns | Zod `input` / `output` at registration |
| `CATALOG.tools` monolith | `registerTool`, `getTool`, `listTools` |

---

## Host migration checklist

### 1. Startup — register once

```ts
import { z } from 'zod';
import { registerTool, registerHarnessTools } from 'theorum';

registerHarnessTools(); // ask_user, etc.

registerTool({
  type: 'function',
  name: 'lookup_order',
  description: '…',
  category: 'operations',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'session_consent',
  input: z.object({ orderId: z.string() }),
  output: z.object({ finding: z.string() }),
  handler: async (input) => ({ finding: `…` }),
});
```

Add **`zod`** as a dependency (`^3.24` peer on npm).

### 2. Profile — ceiling only

```ts
tools: {
  allow: ['lookup_order', 'load_tools', 'googleSearch'],
}
```

Set **`loadTier`** on each registered tool (`T0` / `T1` / `T2`). Profile has no loading mode.

### 3. Turn — opt in

```ts
runTurn({
  profile: 'my.bot',
  tools: { lookup_order: true, load_tools: true },
  sessionPermissions: ['lookup_order'], // session_consent tools
  path: 'web', // catalog path filter
  input: { text: '…' },
}, provider);
```

### 4. Pause resume — `invokeTool`

When `done.stop.kind === 'tool'`:

```ts
invokeTool({
  profile: 'my.bot',
  name: 'delete_resource',
  input: originalArgs,
  resume: { granted: true }, // always_confirm
  // resume: { value: userAnswer }, // ask_user / interactive
});
```

`resume` **skips** turn gating (`not_gated`) when `value` or `granted` is set. It does
**not** bypass T1/T2 load checks — pass `toolLoader` / `promoted` on resume when needed.
T0 paused calls may resume without rebuilding gates. Direct invoke (command palette)
requires `tools: { [id]: true }` like `runTurn`.

### 5. Turn continue — `continueFrom` (not tool pause)

For `length`, `stream_incomplete`, `provider_error`:

```ts
runTurn({
  profile: 'my.bot',
  continueFrom: { stop: previousDone.stop, partialText: '…' },
  tools: { … }, // re-gate tools on the new turn
  input: { text: '…' },
}, provider);
```

Do **not** use `continueFrom` for tool pauses — use `invokeTool`.

---

## Behavior changes (not bugs)

- **`always_confirm`** ignores `sessionPermissions`; only `resume.granted === true` bypasses.
- **`canExecute` returning a pause envelope** — use `preflight` returning a `ToolPause` instead.
- **Loader promoting ad-hoc tools** — loaders may only promote **pre-registered** ids in `allow`.
- **Tool descriptions** — no per-turn `sanitizeDynamicTools`; sanitize at registration if needed.

---

## Event mapping (old → new)

| Old `ToolEnvelope` | New stream |
| --- | --- |
| `status: 'ok'` | `tool.phase: 'complete'` |
| `status: 'pause'` | `tool.phase: 'pause'` (+ `pause.kind`) |
| `status: 'error'` | `tool.phase: 'error'` (+ `failure.code`) |

Model-facing results use `formatToolResult` / `projectForModel` internally; hosts
consume `TurnEvent`s and traces, not envelopes.

---

## Deferred (not in v1)

- `registerExternalToolProvider` (MCP / external dynamic tools)
- Per-tool `projectForModel` override (use `exposeToModel: false` today)
