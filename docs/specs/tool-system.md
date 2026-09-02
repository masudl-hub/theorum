# Tool System Specification

Status: **Implemented** (see `src/kernel/tools/` and `tests/kernel/tools.test.ts`)

This document is the authoritative spec for the ground-up rebuild of tool handling
in THEORUM. It replaces the fragmented catalog + per-turn dynamic declaration
model. There are **no compatibility shims** with the old world.

Related (superseded on implementation):

- `ToolCatalogEntry`, `DynamicToolDeclaration`, `ToolEnvelope` in `src/kernel/types.ts`
- `src/kernel/registry/catalog.ts`, `src/kernel/registry/tools.ts`
- Per-turn `TurnRequest.dynamicTools` / `dynamicToolLoader`

---

## 1. Problem

The current tool system splits one concept across too many places:

| Concern | Old location |
| --- | --- |
| Tool exists | `ToolCatalogEntry` (optional) |
| Profile may use it | `profile.tools.allow` |
| Turn has it on | `TurnRequest.tools[id]: true` |
| Model sees schema | `DynamicToolDeclaration.parameters` (re-declared every turn) |
| Code runs | `DynamicToolDeclaration.handler` (re-declared every turn) |
| Wire metadata | `ToolCatalogEntry.interactionsType`, etc. |
| Result shape | Ad hoc `ToolEnvelope` |

Hosts (notably Orchid) maintain a canonical definition, then bridge it into
`DynamicToolDeclaration[]` on every turn. Policy, load tier, and permission tier
are tracked in the host but not enforced consistently by the kernel.

This spec collapses tool identity into **one registry**, keeps profiles thin,
and gives the kernel a single execution path.

---

## 2. Principles

1. **One registry** — `registerTool` at host startup. No per-turn
   re-declaration of schemas or handlers.
2. **Catalog vs profile vs turn** — the registry describes what a tool *is*; the
   profile describes who *may* use it; the turn describes what is *on* right now.
3. **Kill the old world** — no deprecation period, no compatibility shims.
4. **Stateless kernel** — pause, confirmation, and persistence are host concerns.
   The kernel emits events; the host owns state machines and IDs.
5. **Shared execute core** — `runTurn` (model-initiated) and `invokeTool`
   (host-initiated) call the same execution module. Not a thin wrapper or bypass
   flag tacked onto the turn runner.
6. **Simplest profile** — `profile.tools.allow` lists tool ids. Policy, load
   tier, paths, and access live on the catalog entry.
7. **Typed customs** — function tools use Zod input/output schemas validated at
   registration and execution boundaries.
8. **Kernel exposes everything** — streaming progress, trace, artifacts, warnings
   are forwarded on the turn stream. The host decides what to render, persist, or
   feed back to the model.

---

## 3. Package layout

New module tree:

```
src/kernel/tools/
├── mod.ts           # Public exports
├── types.ts         # ToolDefinition, ToolContext, ToolStreamEvent, failures
├── schema.ts        # JsonSchema derivation, provider validation (Gemini allowlist)
├── define.ts        # defineTool() — validates and normalizes definitions
├── registry.ts      # registerTool(), getTool(), listTools()
├── resolve.ts       # resolveTurnTools(), expandTurnToolLoader(), promoteLoadedTools()
├── execute.ts       # Shared execution core (used by runTurn and invokeTool)
├── invoke.ts        # invokeTool() host entrypoint
├── project.ts       # projectTools() for host/UI inspection
└── harness.ts       # registerHarnessTools() for tests and demos
```

Wire projection lives in `resolve.ts` (`buildWire`, `TurnToolSnapshot.wire`). There is no
separate `visibility.ts` or `wire.ts`.

Exports via `theorum/kernel` (and root re-exports as appropriate).

**Deleted on implementation:**

- `src/kernel/registry/catalog.ts` (tool catalog portions)
- `src/kernel/registry/tools.ts`
- Dual dispatch in `runner/stream.ts` vs `runner/steps.ts` (replaced by single path
  through `execute.ts`)
- `DynamicToolDeclaration`, `ToolCatalogEntry`, host-facing `ToolEnvelope`

---

## 4. Tool definition (`defineTool`)

Single entry point. Discriminated by `type` where behavior genuinely differs.

### 4.1 Shared base fields (all types)

```ts
interface ToolBase {
  name: string;
  description: string;

  /** Grouping label for settings, discovery, host policy. */
  category: string;

  /**
   * Semantic access level — used by kernel, host policy, and UI.
   * Not nested under a `ui` bucket.
   */
  access: 'read-only' | 'read-write' | 'destructive';

  /** Channel/path availability — kernel filters at resolve time. */
  paths: string[];

  /**
   * Visibility tier — single source of truth on the tool definition.
   * - T0: wired at turn start when gated on
   * - T1: wired when TurnRequest.toolLoader selects it
   * - T2: wired when a loader tool promotes it mid-turn
   */
  loadTier: 'T0' | 'T1' | 'T2';

  permission: 'auto' | 'session_consent' | 'always_confirm';

  /** Optional presentation hints — non-authoritative. */
  labels?: {
    activity?: string;
    activityPast?: string;
    hiddenFromSettings?: boolean;
  };
}
```

### 4.2 `type: 'builtin'`

Provider-native capability. No handler, no input/output schema.

```ts
interface BuiltinToolDef extends ToolBase {
  type: 'builtin';
  wire: {
    interactions?: string;   // e.g. 'google_search'
    openRouter?: string;     // e.g. 'web' plugin id
  };
  conflictsWith?: string[];
}
```

Builtins are **not** typed on input/output — the provider owns execution.

For builtins, `loadTier` controls when the kernel includes the id in
`generation.builtins` for the provider adapter (capability pins — not function
schemas in `wireTools`). Turn gating via `tools: { id: true }` is still required.
Preset builtins register as `T0`; use `T1` only when a host wants capability pins
selected by `toolLoader` rather than at turn start.

### 4.3 `type: 'function'`

Host-owned tool with full contract.

```ts
interface FunctionToolDef<TIn, TOut> extends ToolBase {
  type: 'function';
  input: ZodSchema<TIn>;
  output: ZodSchema<TOut>;

  handler: ToolHandler<TIn, TOut>;

  /**
   * Optional interactive mode — same tool type, not a separate `type`.
   * When set, the first call renders a pause instead of running handler
   * (unless ctx.resume is present — see §8).
   */
  interactive?: {
    render: (input: TIn) => InteractiveRender;
  };

  canExecute?: (input: TIn, ctx: ToolContext) => boolean;
  preflight?: (input: TIn, ctx: ToolContext) => void | ToolFailure;

  /** When false, kernel omits result data from model-facing projection. Default true. */
  exposeToModel?: boolean;
}
```

**Interactive is not a separate type.** Any function tool may be interactive.
Normal functions omit `interactive`.

**Polymorphic policy** (e.g. `manage_collection:delete` vs `:create`): handled in
`handler` / `preflight` only — return a pause or failure for destructive actions.
The catalog carries a single default `permission` tier per tool. No
`tool:action` policy keys in the kernel.

**Domain-specific optional input fields** (e.g. Orchid `action_confidence`,
`action_rationale`) belong in the tool's Zod input schema as optional fields —
not as kernel globals.

### 4.4 `type: 'loader'`

Expands visible tools mid-turn. Still a registered tool with input/output schemas.

```ts
interface LoaderToolDef extends ToolBase {
  type: 'loader';
  input: ZodSchema;
  output: ZodSchema;
  resolve: (input: unknown, ctx: ToolContext) => { loaded: string[] };
}
```

**Registration rule:** `loadTier` must be **`T0`**. Loaders must be callable at turn
start; they promote **`T2`** tools only (enforced when `resolve()` returns ids).

T2 tools use `loadTier: 'T2'` on the definition and become visible when a
registered loader tool's `resolve()` promotes them mid-turn. T0 tools wire at
turn start; T1 tools wire when `TurnRequest.toolLoader` selects them.

### 4.5 Explicitly excluded

- **Aliases** — retired. Unknown tool names fail normally.
- **Tombstones** — host migration concern only, not kernel feature.
- **JSON Schema passthrough** — v1 requires Zod on function/loader tools.
- **Separate `defineBuiltin` / `defineLoader` / `defineInteractive` APIs** — one
  `defineTool`.

---

## 5. Schema (Zod)

- **`zod`** is a **peer dependency** of `@theorum/core` (support `^3` and `^4`).
- Wire JSON Schema is **derived at registration** (via `zod-to-json-schema` or
  equivalent).
- All function/loader input schemas are validated at registration against:
  - Structural rules (universal)
  - Gemini allowlist (strict — port from Seance `tool_schema_contract.ts`)
- **Input** validated before handler runs.
- **Output** validated on terminal `complete` event before model projection.

Orchid and other hosts already use Zod in agent paths; tool definitions migrate
to Zod once.

---

## 6. Profile

```ts
interface ProfileTools {
  /** Security ceiling — every tool that could ever run, including T2 deferred. */
  allow: string[];
}
```

**No** per-profile loading mode, policy map, or loaders list. `loadTier` and
`permission` live on each tool definition.

**Path filtering:** catalog `paths` + turn context path (host passes path on
turn or profile context). Kernel intersects at resolve time.

---

## 7. Turn request

```ts
interface TurnRequest {
  profile: ProfileId;

  /** Opt-in gates. Tool must be in profile allow AND gated on here. */
  tools?: Partial<Record<ToolId, boolean>>;

  /** Grants for session_consent / always_confirm tools. May include '*' . */
  sessionPermissions?: string[];

  /** Host channel/path for catalog path filtering. */
  path?: string;

  /** Host-owned T1 resolver — returns tool ids to wire at turn start. */
  toolLoader?: (ctx: ToolLoadContext) => ToolId[] | Promise<ToolId[]>;

  // ... existing fields (input, system, stream, etc.)
}
```

**Removed from TurnRequest:**

- `dynamicTools`
- `dynamicToolLoader` (replaced by registered loader tools for T2)
- `toolInvoke` (replaced by separate `invokeTool` entrypoint)

---

## 8. Turn resolution

At `resolveTurn`, kernel builds a **`TurnToolSnapshot`** (T0 only). **`runTurn`** and
**`invokeTool`** then call **`expandTurnToolLoader`** (async) when `toolLoader` is set.
Use **`prepareTurnToolSnapshot(profile, turn)`** when a host needs the fully expanded snapshot
without running a turn.

```ts
interface TurnToolSnapshot {
  builtins: string[];       // T0 (+ T1 after toolLoader) capability pins
  gated: string[];          // allow + path + tools[id] === true
  visible: string[];        // schemas sent to provider (respects loadTier + loader)
  executable: string[];     // visible function/loader tools the kernel can execute
  wire: WireFunctionTool[]; // provider function schemas derived from visible
  path?: string;
  sessionPermissions?: string[];
}
```

Rules:

1. Start from `profile.tools.allow`.
2. Filter by catalog `paths` and turn `path`. When turn `path` is omitted, only tools
   whose catalog `paths` includes `'*'` match.
3. Apply turn gate `tools[id] === true`.
4. Apply visibility by **`loadTier` on each tool**:
   - `T0` → visible at turn start (builtins → `builtins[]`; functions → `visible`/`wire`)
   - `T1` → visible when `toolLoader` returns the id (builtins → `builtins[]`; functions → `visible`/`wire`)
   - `T2` → hidden until a loader tool promotes it into `visible`/`wire`
5. Loader `resolve()` may promote **`T2`** tools from allow → visible.
   **Never promotes tools outside allow or wrong tier.** Loader output lists only ids
   actually promoted (ungated or wrong-path ids are skipped silently).
6. Builtins: capability pins in `builtins[]`. Not kernel-executed.

Runtime visibility state mutates in-place during a turn when loaders succeed
(same as today's `mergeDynamicTools`, but sourced from registry).

---

## 9. Execution architecture

### 9.1 Shared execute core

```
src/kernel/tools/execute.ts
```

Single module responsible for:

1. Registry lookup
2. Input validation (Zod)
3. Permission check (`permission` + `sessionPermissions`)
4. `canExecute` / `preflight`
5. Interactive first-call → pause (when `interactive` set and resume has no `value`)
6. Handler invocation (sync, async, or async generator)
7. Stream event forwarding
8. Output validation on terminal complete
9. Model projection

Both **`runTurn`** (model-initiated tool calls inside the provider loop) and
**`invokeTool`** (host-initiated) call this module directly.

This is **not** a thin wrapper. `runTurn` does not branch early with a hack;
`invokeTool` is not a fake turn. They share `execute.ts`.

### 9.2 `runTurn` — model-initiated

Normal agent turn:

1. Resolve tools → wire schemas to provider
2. Provider streams; model may emit tool calls
3. Each tool call → `execute.ts`
4. Result fed back via Interactions continuation or OpenAI-compat history
5. Multi-step loop until text or `maxSteps`

Builtins pass through without kernel handler execution (provider-native).

### 9.3 `invokeTool` — host-initiated

Separate public entrypoint:

```ts
function invokeTool(request: InvokeToolRequest): AsyncGenerator<TurnEvent>;

interface InvokeToolRequest {
  profile: ProfileId;
  name: string;
  input: unknown;
  /** Turn opt-in gates — required unless `resume` continues a paused call. */
  tools?: Partial<Record<ToolId, boolean>>;
  /** Turn input for `toolLoader` selection (same as `TurnRequest.input`). */
  turnInput?: TurnInput;
  /** T1 selection — same contract as `TurnRequest.toolLoader`. */
  toolLoader?: TurnToolLoader;
  /** T2 ids already promoted for this invoke (restored from pause metadata). */
  promoted?: ToolId[];
  resume?: InvokeToolResume;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
}

interface InvokeToolResume {
  /** User answer, approval grant, etc. — shape depends on tool. */
  value?: unknown;
  granted?: boolean;
}
```

- **Never** calls the provider
- **Never** runs the multi-step agent loop
- Uses the same `execute.ts` path as model-initiated calls
- **`resume`** skips turn gating (`not_gated`) when `value` or `granted` is set; it does
  **not** skip deferred-load checks for T1/T2. T0 paused calls may resume without rebuilding
  the snapshot. T2 resume requires `promoted` (or a fresh loader run). Direct invoke requires
  `tools[id]: true` like `runTurn`
- Expands `toolLoader` before execution (same as `runTurn`)
- Same `TurnEvent` stream shape (`tool` events + terminal `done`) — no extra generic `error` event
- Used for: confirmation resume, `ask_user` answer, command palette, tests

### 9.4 One registry, two callers

| Caller | Entrypoint | Provider | Typical use |
| --- | --- | --- | --- |
| LLM | `runTurn` | Yes | Chat, agent loop |
| Host | `invokeTool` | No | Approve, answer prompt, direct run |

Same `defineTool` registration. Same handler. Same validation.

---

## 10. Handler shapes and streaming

```ts
type ToolHandler<TIn, TOut> =
  | ((input: TIn, ctx: ToolContext) => Promise<TOut>)
  | ((input: TIn, ctx: ToolContext) => AsyncGenerator<ToolStreamEvent<TOut>>);

type ToolStreamEvent<TOut> =
  | { kind: 'progress'; data: unknown }
  | { kind: 'trace'; step: ToolTraceStep }
  | { kind: 'artifact'; artifact: unknown }
  | { kind: 'warning'; warning: ToolWarning }
  | { kind: 'complete'; output: TOut };
```

### Turn stream events during tool execution

```ts
{ type: 'tool', tool: { name, callId, phase: 'running' } }
{ type: 'tool', tool: { name, callId, phase: 'progress', data } }
{ type: 'tool', tool: { name, callId, phase: 'trace', step } }
{ type: 'tool', tool: { name, callId, phase: 'artifact', artifact } }
{ type: 'tool', tool: { name, callId, phase: 'warning', warning } }
{ type: 'tool', tool: { name, callId, phase: 'complete', output } }
{ type: 'tool', tool: { name, callId, phase: 'pause', pause } }
{ type: 'tool', tool: { name, callId, phase: 'error', failure } }
```

Kernel validates `complete.output` against Zod. Progress/trace/artifact/warning
events pass through — host uses them for UI, audit, activity feeds. Model sees
only the projected terminal result unless the host configures otherwise.

### ToolContext

```ts
interface ToolContext {
  profile: Profile;
  callId: string;
  sessionPermissions?: string[];
  path?: string;
  signal?: AbortSignal;
  turn?: { step: number };
  resume?: InvokeToolResume;
}
```

---

## 11. Pause and confirmation (stateless kernel)

The kernel **does not**:

- Generate confirmation `requestId`
- Persist pending operations
- Block waiting for human input

The kernel **does** emit pause events:

```ts
interface ToolPause {
  kind: 'interactive' | 'confirmation' | 'permission';
  tool: string;
  render?: InteractiveRender;   // interactive
  summary?: string;              // confirmation
  input: unknown;                // original args for host replay
  permission?: ToolPermission;
}
```

Turn ends with `done.stop.kind: 'tool'`. Host shows UI, persists if needed, then
calls `invokeTool` with `resume` when ready.

**Interactive tools** (`interactive.render`):

- First call (no `ctx.resume.value`): kernel calls `render(input)`, emits pause, stops
- Resume call via `invokeTool`: kernel runs `handler` when `ctx.resume.value` is set
  (`granted` alone resumes permission/confirmation, not interactive)

**Policy confirmation** (Orchid-style):

- `preflight` or handler returns pause with `kind: 'confirmation'`
- Host persists and resumes via `invokeTool`

---

## 12. Failure cases

| Failure | Code | Handler called? | Model sees |
| --- | --- | --- | --- |
| Input validation | `invalid_input` | No | Safe error finding |
| Output validation | `invalid_output` | Yes (bug) | Safe error finding |
| Handler throw | `handler_error` | Yes | Sanitized finding |
| Not registered | `unknown_tool` | No | Tool not available |
| Not in allow | `not_allowed` | No | — |
| Not gated on turn | `not_gated` | No | Tool not enabled |
| Not visible (deferred) | `not_loaded` | No | Hint to use loader |
| `canExecute` false or throw | `not_authorized` | No | Not authorized |
| Permission pause | — (pause) | No | — |
| Preflight failure | host-defined | No | Preflight message |
| Loader failure | `loader_error` | — | Error finding |
| Loader pause before expand | — (pause) | No | No expansion |
| Builtin provider error | — | N/A | Provider evidence |

Validation failures are never silent. Input failures do not invoke the handler.

---

## 13. Model projection

After successful execution, kernel projects handler output for the model:

```ts
interface ModelToolResult {
  finding: string;
  data: unknown;
}
```

- Default: validated output JSON
- `exposeToModel: false` → finding only, omit data (Orchid `think_deeply`,
  `manage_memory` pattern)
- Optional per-tool `projectForModel?(output): unknown` if needed later

Host may compact further before history append (Seance-style) — outside kernel v1.

---

## 14. Provider wire

`resolve.ts` reads `TurnToolSnapshot` and produces provider-specific declarations via
`generation.tools.wire` and `generation.builtins`:

- **Interactions:** builtins as `{ type }`, functions as `{ type: 'function', name,
  description, parameters }`
- **OpenAI-compat:** function tools via existing compat helpers; OpenRouter plugins
  from builtins

Schema source is always registry-derived JSON Schema — never a duplicate
`parameters` blob on the turn request.

Continuation strategies (preserve existing behavior):

- **Interactions:** `previousInteractionId` + `function_result` steps
- **OpenAI-compat:** assistant `tool_calls` + tool role history

---

## 15. Harness tool migration

`askUser` becomes a registered function tool with `interactive`:

```ts
registerTool({
  type: 'function',
  name: 'ask_user',
  category: 'conversation',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: AskInputSchema,
  output: AskOutputSchema,
  interactive: {
    render: (input) => ({
      kind: input.kind,
      prompt: input.prompt,
      options: input.options,
    }),
  },
  handler: (input, ctx) => ({
    answer: ctx.resume?.value,
  }),
});
```

Ships with THEORUM or host registers at startup — not a special-case executor in
`registry/tools.ts`.

---

## 16. Host registration pattern (Orchid)

```ts
// Startup — once
for (const def of ALL_TOOL_DEFINITIONS) {
  registerTool(def);
}

// Profile — allow list only
defineProfile({
  id: 'orchid.orchestrator',
  tools: {
    allow: ORCHESTRATOR_TOOL_IDS,
  },
  },
});

// Turn
runTurn({
  profile: 'orchid.orchestrator',
  path: 'web',
  tools: { manage_collection: true, load_tools: true },
  input: { text: '...' },
}, provider);
```

**Deleted in Orchid (post-flip):**

- `dynamic-tools.ts` / `buildDynamicToolDeclarations`
- `toTheorumEnvelope` bridge
- Duplicate policy in bridge (`permissionTier: 'auto'` hardcode)
- Per-turn handler re-declaration

Orchid keeps rich `ToolOutcome` / trace internally; kernel receives stream events
and projected model result. Mapping lives in Orchid, not the kernel.

---

## 17. Seance mapping (future)

If Seance moves to THEORUM:

| Seance | THEORUM |
| --- | --- |
| `defineAgentTool` | `defineTool({ type: 'function', ... })` |
| `capability_group` | `category` |
| `destructiveness` | `access` |
| `discover_more_tools` | `type: 'loader'` tool |
| `executeToolCall` | `invokeTool` or in-turn execute |
| `guard` / approval | `preflight` → pause; host resume via `invokeTool` |
| MCP external tools | `registerExternalToolProvider` (future extension) |
| Hand-authored JSON Schema | Migrate to Zod |

Seance's Gemini schema validation moves into `src/kernel/tools/schema.ts`.

---

## 18. Implementation order

1. `tools/types.ts`, `tools/schema.ts` — definitions, validation, stream events
2. `tools/define.ts`, `tools/registry.ts` — registration
3. `tools/resolve.ts`, `tools/visibility.ts` — turn snapshot
4. `tools/execute.ts` — shared execution core
5. `tools/wire.ts` — provider projection; update Interactions + OpenAI-compat
6. `invokeTool` export — host entrypoint sharing `execute.ts`
7. Runner rewrite — single dispatch through `execute.ts`
8. Delete old tool modules and types
9. Port kernel tests
10. Orchid flip (separate effort)

---

## 19. Open items (deferred)

- **`registerExternalToolProvider`** for MCP/dynamic external tools (Seance pattern)
- **Per-tool `projectForModel`** override (if `exposeToModel` is insufficient)

Host migration guide: **`docs/MIGRATION-tool-system.md`**

---

## 20. Decision log

| Date | Decision |
| --- | --- |
| 2026-09-01 | Ground-up rebuild; no compatibility shims |
| 2026-09-01 | One `defineTool`; types: builtin, function, loader |
| 2026-09-01 | Interactive is optional on function — not a separate type |
| 2026-09-01 | Profile: `tools.allow` ceiling only; `loadTier` on each tool (T0/T1/T2) |
| 2026-09-01 | T1 via `TurnRequest.toolLoader`; T2 via registered loader tools |
| 2026-09-01 | Policy, loadTier, paths, access on catalog |
| 2026-09-01 | `access`: read-only \| read-write \| destructive |
| 2026-09-01 | Field name: `category` (not group / capability_group) |
| 2026-09-01 | Path availability on catalog; kernel filters |
| 2026-09-01 | Zod required for function/loader tools; peer dependency |
| 2026-09-01 | Polymorphic policy in handler/preflight only |
| 2026-09-01 | No aliases, no tombstones in kernel |
| 2026-09-01 | Pause stateless — host persists, `invokeTool` resumes |
| 2026-09-01 | Streaming via async generator handlers |
| 2026-09-01 | `invokeTool` separate entrypoint; shared `execute.ts` — not a thin shim |
| 2026-09-01 | Pressure-test hardening: invoke resume cannot cold-start T2; `toolLoader`/`promoted` on `invokeTool`; T1 builtins deferred; loader output honest; path omitted matches `*` only |
| 2026-09-01 | Kill `DynamicToolDeclaration`, `ToolCatalogEntry`, `ToolEnvelope` |
