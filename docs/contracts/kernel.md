# Kernel (`theorum/kernel`)

Type-first contracts for profiles, turns, tools, compaction, stop/resume, and
`runTurn`. Import here when a host needs the kernel surface without pulling
provider adapters.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/kernel` / `jsr:@theorum/core/kernel` |
| Module | `src/kernel/mod.ts` |
| Also on | Root `theorum` / `mod.ts` re-exports the same runner and many helpers |

## Ownership

| Scope | Path |
| --- | --- |
| Tree | `src/kernel/` (engine, registry, `stop.ts`, `types.ts`) |

## Profiles

Hosts declare agents with `defineProfile` / `registerProfile` (or
`registerProfiles`). `getProfile` / `hasProfile` / `listProfiles` / `clearProfiles`
manage the in-memory registry.

A `Profile` binds:

| Block | Role |
| --- | --- |
| `identity` | `handle`, optional `chat`, `system` / `systemByRole` |
| `model` | `protocol`, `provider`, `allow`, `config`, optional `select` / `thinking` / `controls` / `maxSteps` / `key` |
| `tools` | Allowlist ceiling (`allow: ToolId[]`) |
| `inputs` | Text / attachments / voice / slots / per-mime limits |
| `outputs` | Structured, image, speech, streaming, validation, `resume` |
| `guardrails` | Quota, canary, sanitize, redact, egress |

Closed unions (`protocol`, `provider`, `thinking`, stop kinds, MIME maps, …)
live as `as const` arrays in `src/kernel/schema.ts`. Types are derived from
those arrays. `PROFILE_FIELDS` / `fieldMeta` document every authoring path so
host UIs and docs hover the live kernel types instead of copying them.

Multimodal ingress uses provider-neutral `InteractionPart` values;
`InteractionMediaPart.type` is `MediaInputKind` (`image` | `audio` | `video` |
`document`). MIME → kind mapping lives in `MEDIA_INPUT_KINDS` (`schema.ts`)
and is applied by `mediaKindForMime` (`catalog.ts`).

`model.protocol` is `PROTOCOLS` (`geminiInteractions` | `openAi`).
`model.provider` is `PROVIDERS` (`google` | `openrouter` | `local`).
Legal pairs are `PROTOCOL_PROVIDERS`; `createProvider` rejects anything
outside `isValidPair`. `providersFor` / `protocolsFor` / `coerceProvider` /
`coerceProtocol` are the same table.
Every id in `allow` must exist in `config`. Each `ModelSpec` carries wire ids
(`apiId`), `thinking` / `summaries` maps,
`thinkingLevels`, `maxOutputTokens`, `temperature`, `builtInTools`, optional
vault `key`, optional `compaction`.

Defaults applied at registration (`profiles.ts`):

| Field | Default when omitted |
| --- | --- |
| `model.maxSteps` | `1` |
| `guardrails.canary` | `true` |
| `guardrails.sanitizeInput` | profile-dependent |
| `guardrails.redactSensitive` | profile-dependent |

`projectProfile` / `resolveTurn` project a registered profile + `TurnRequest`
into a `ProjectedProfile` / `ResolvedGeneration` the runner and providers consume.

## Turn lifecycle

`runTurn(request, provider, sink?)` is the single deterministic execution path
for one agent turn. Pipeline (see `engine/runner/mod.ts`):

1. **Resolve** — `resolveTurn` picks model, wire `apiId`, `transport`
   (`'interactions'` for Google Interactions, `'openAiCompat'` for OpenRouter/local),
   thinking, tools, structured schema, streaming flags (`TurnRequest.stream` for
   Interactions SSE vs JSON), canary token.
2. **Sanitize** — `sanitizeTurnRequest` strips injection/sensitive spans per
   profile guardrails (unless disabled).
3. **Compaction (before)** — when `timing: 'before'` and threshold fires, kernel
   runs the compaction profile turn synchronously, then continues with trimmed
   history.
4. **Canary bind** — `bindCanary` embeds the per-turn canary in system text when
   `guardrails.canary` is enabled.
5. **Provider stream** — `provider.complete` yields partial events; runner may
   gate thoughts/media per `outputs.streaming`.
6. **Tool loop** — while under `maxSteps`, tool calls execute via `executeRegisteredTool`
   (shared with `invokeTool`); results feed the next step. `generation.transport` selects
   Interactions continuation (`previous_interaction_id` + `function_result` steps) vs
   OpenAI-compat tool-call history. Server-side `codeExecution` does not consume a runner step.
7. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`.
8. **Egress** — `guardrails.egress.enforce` may block, refuse, or retry with
   repair guidance before releasing user-visible text.
9. **Trace** — optional sink receives a `TraceRecord`; failures are swallowed.
   Runner threads `profile.model.protocol` and upstream tap rows (`tapUpstream`).
   Interactions turns snapshot `wire` via `toInteractionsBody`; OpenAI-compat turns
   omit wire and classify ok/cancelled from terminal `done.stop` on the event stream.
10. **Terminal `done`** — one `done` event with tokens, optional `stop`,
    optional `compaction` signal (`timing: 'after'`).

`continueFrom` on `TurnRequest` prepends `CONTINUE_INSTRUCTION` and carries
partial assistant text/artifact from a resumeable stop.

Optional `compactionProvider` on `TurnRequest` when the compactor profile uses a
different transport than the primary turn.

## Stream events

`runTurn` and adapters yield `TurnEvent`:

| `type` | Payload highlights |
| --- | --- |
| `thought` | Model reasoning stream (may be gated) |
| `text` | User-visible assistant text |
| `tool` | Tool call envelope (`ok` / `error` / `pause`) |
| `structured` | Parsed JSON object when schema enforced |
| `media` | Generated image/audio bytes + mime |
| `grounding` | Search/maps grounding metadata (classic `grounding_metadata` and Interactions tool results such as `google_search_result.search_suggestions`) |
| `evidence` | Provider-native attachments. Google code execution sets `kind` (`code_execution_call` / `code_execution_result`) plus parsed `code` / `result` / `isError` / `id` / `callId`, and always keeps `raw`. |
| `tokens` | `input` / `output` / `total` usage (billing; may gate `meter: 'input'`) |
| `done` | Terminal: `stop`, `tokens`, `compaction`, final text pointer |
| `error` | Public-safe failure (`toErrorEvent`) |

`TurnHistoryMessage` preserves `role`, `content`, `parts`, `tool_calls`,
`tool_call_id`, and opaque `metadata` across turns.

Google Interactions code execution (`codeExecution` builtin) is a server-side
tool: THEORUM does not run Python. Hosts receive the sandbox timeline as
`evidence` events (streamed SSE deltas, or a batched replay of `steps[]` when
`TurnRequest.stream === false`). Generated plots/annotated images arrive as
`media`. `maxSteps` does not bound Google's internal code loop; it only bounds
host function-calling round trips. The sandbox runtime cap (~30s per execution)
is Google's, not a THEORUM setting.

`stream` on `TurnRequest` / `ProviderCompleteRequest` defaults to SSE (`true`).
`false` POSTs without `alt=sse` and folds the JSON `interaction` into the same
event types.

## Registered tools

Tools are registered once at host startup via `registerTool`. Profiles
declare a ceiling with `tools.allow`; turns opt in with `tools: { [id]: true }`.

```ts
// Startup
registerTool({
  type: 'function',
  name: 'lookup_order',
  description: 'Fetch order state',
  category: 'operations',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'session_consent',
  input: z.object({ orderId: z.string() }),
  output: z.object({ finding: z.string() }),
  handler: async (input) => ({ finding: `Order ${input.orderId} is in transit.` }),
});

// Profile — allow ceiling only
tools: { allow: ['lookup_order', 'load_tools'] }

// Turn — gate + optional T1 resolver
runTurn({
  profile,
  tools: { lookup_order: true },
  toolLoader: (ctx) => (ctx.input?.text?.includes('order') ? ['lookup_order'] : []),
  input: { text: '...' },
}, provider);

// Host resume (interactive, confirmation, permission)
invokeTool({ profile, name: 'ask_user', input: {...}, resume: { value: 'yes' } });

// Host direct invoke (command palette) — gate like a turn
invokeTool({ profile, name: 'lookup_order', input: {...}, tools: { lookup_order: true } });
```

| Layer | Owner | Role |
| --- | --- | --- |
| Catalog | Registry | Schema, handler, `access`, `loadTier`, `permission`, wire metadata |
| Profile | Host | `tools.allow` ceiling only |
| Turn | Host | `tools[id]: true` gates; `toolLoader` for T1; `sessionPermissions` for consent |
| Execution | Kernel | Shared `executeRegisteredTool` for model and `invokeTool` paths |

Builtins (`type: 'builtin'`) are provider-native — kernel pins capabilities in
`generation.builtins` but does not execute handlers. Function and loader tools require
Zod input/output validated at registration.
Catalog `conflictsWith` enforces builtin mutual exclusion (e.g. Google maps vs search).
MIME classification (`MEDIA_INPUT_KINDS`, `ATTACHMENT_ACCEPT_MIMES`, …) lives in
`schema.ts`. Tool catalog constants: `TOOL_LOAD_TIERS`, `TOOL_ACCESS_LEVELS`,
`TOOL_PERMISSION_TIERS`.

## Outputs and guardrails

Profile `outputs` pins behavior the kernel enforces before adapters run:

| Pin | Effect |
| --- | --- |
| `structured` | Schema id or slot-mapped ids; `responseFormat` vs prompt enforcement |
| `image` | Aspect ratio, size, mime, grounding allowance, max input images |
| `speech` | TTS voice + `format` (`pcm` → WAV; `mp3` OpenAI-only) |
| `streaming` | `mode`, `streamThoughts`, `gateMedia` |
| `validation` | Field validators + `maxRetries` + `repairGuidance` |
| `resume` | `allowContinue` / `autoContinue` stop kinds |

Profile `guardrails`:

| Flag | Effect |
| --- | --- |
| `quota` | Host HTTP helper only (`theorum/guardrails`); not enforced inside `runTurn` |
| `canary` | Per-turn canary token; egress checks leakage |
| `sanitizeInput` / `redactSensitive` | Pre-provider text/blob scrub |
| `egress` | Host `enforce` hook; `onBlock`: `reject_to_agent` or `refuse_to_user` |

## Compaction

Optional per-model policy on `ModelSpec.compaction`. Kernel owns trigger, split,
and timing; host owns persistence/reassembly unless `timing: 'before'` runs the
compactor inline.

```ts
compaction: {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  profile: "my.compactor",
  timing: "after",
  meter: "history",
  trigger: (ctx) =>
    ctx.tokens > ctx.compactAt * ctx.maxTokens || hostRamPressure(),
}
```

### Meter

| Value | Counts |
| --- | --- |
| `history` (default) | `input.historyTokens` or local estimate of `history` only |
| `input` | Full prompt: `input.inputTokens` (before) or `tokens.input` (after) |

Provider `tokens` events always stream; they gate compaction only when
`meter: 'input'`.

### History estimate (`meter: 'history'`)

1. Host `historyTokens` wins when set.
2. Else estimate from `input.history`:
   - **Text** — tiktoken `o200k_base` (`HISTORY_TEXT_ENCODING`) over content,
     text parts, tool-call arguments. Loads **lazily** on first text estimate.
   - **Media** — stubs when size unknown (`HISTORY_MEDIA_TOKENS`: image/document
     258, audio 32, video 263).
   - Current-turn attachments/voice are **not** history.

### `previousExchanges`

| Value | Retain |
| --- | --- |
| `≥ 1` integer | That many recent user-started exchanges |
| `(0, 1)` fraction | Tail fitting in `fraction * maxTokens` (must be `< compactAt`) |
| `0` | Compact everything |

### Compaction profile

A compaction profile is a normal registered profile. Minimal summarizer:

```ts
registerProfile(defineProfile({
  id: "my.compactor",
  identity: {
    handle: "Compactor",
    system: "Summarize this conversation concisely. Preserve unresolved issues, "
      + "decisions, and key facts.",
  },
  model: { /* allow + config */, maxSteps: 1 },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: "my.summary.schema" },
  guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
}));
```

### After-turn signal

```ts
for await (const event of runTurn(req, provider)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, tokens, meter, promptTokens } = event.compaction;
    // host runs compactor async, rewrites persisted history
  }
}
```

### Compaction exports

| Export | Role |
| --- | --- |
| `CompactionSpec` / `CompactionMeter` / `CompactionTriggerContext` | Config types |
| `CompactionSignal` | `done.compaction` payload |
| `CompactionSplit` / `CompactionTokens` | Split + resolved counts |
| `resolveHistoryTokens` / `resolveCompactionTokens` | Meter resolution |
| `estimateHistoryTokens` | Local BPE + media stubs |
| `compactionNeeded` / `shouldCompact` | Threshold / custom trigger |
| `splitForCompaction` | `{ toCompact, toRetain }` |

Register-time validation: `maxTokens > 0`, `compactAt ∈ (0,1)`, integer
`previousExchanges ≥ 1`, fractional `< compactAt`, meter ∈ `{history,input}`,
compaction profile registered first.

## Stop and resume

`TurnStopKind` values are the `TURN_STOP_KINDS` array in `src/kernel/schema.ts`.
Providers map native finish reasons into `TurnStop` on terminal `done` events.

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | Model requested tool use |
| `filtered` | Content filter |
| `provider_error` | Upstream failure |
| `cancelled` | User / host abort |
| `stream_incomplete` | Stream ended without terminal reason |

Mappers: `turnStopFromOpenAiFinishReason`, `turnStopFromInteractionStatus`,
`turnStopFromClientStreamEnd` (host SSE drop).

### Resume policy

```ts
outputs: {
  resume: {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  },
}
```

| Constant / helper | Value / role |
| --- | --- |
| `DEFAULT_ALLOW_CONTINUE` | length, stream_incomplete, provider_error |
| `DEFAULT_AUTO_CONTINUE` | length, stream_incomplete |
| `AUTO_CONTINUE_DELAY_MS` | `1500` — suggested pause before one-shot auto-continue |
| `CONTINUE_INSTRUCTION` | Fixed continue system text (do not replace per app) |
| `isResumeableStop` | Profile `allowContinue` or default |
| `shouldAutoContinue` | One silent resume; never for `cancelled` |
| `isUserCancelledStop` | `kind === 'cancelled'` |

### Continue turn

```ts
for await (const event of runTurn({
  profile: "my.agent",
  input: { text: "" },
  continueFrom: {
    stop: previousDone.stop,
    partialText: bufferedAssistantText,
  },
}, provider)) { /* … */ }
```

`GenerationStopError` / `isGenerationStopError` optional throw path for hosts
that prefer exceptions over stream `done.stop`.

## Validation

Beyond compaction rules (above), `registerProfile` asserts:

- Each `tools.allow` / `model.allow` id resolves to catalog / config entries.
- Profiles with attachments or voice set `maxFiles`, `maxBytes`, `maxTurnBytes`.

Runtime structured validation uses `outputs.validation.fields` keyed by dotted
paths; failures can trigger repair turns via `input.repair`.

## Exported API

Live barrel: `src/kernel/mod.ts`. Type surface: `export type *` from
`types.ts` (all public kernel types).

| Group | Symbols |
| --- | --- |
| Compaction | `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `estimateHistoryTokens`, `HISTORY_MEDIA_TOKENS`, `HISTORY_TEXT_ENCODING`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Runner | `runTurn` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaKindForMime`, `getTool`, `listBuiltinIds`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelSpec`, `resetTools` |
| Schema | `PROFILE_FIELDS`, `EXTRA_FIELDS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `PROTOCOLS`, `PROVIDERS`, `PROTOCOL_PROVIDERS`, `providersFor`, `protocolsFor`, `isValidPair`, `coerceProvider`, `coerceProtocol`, `THINKING_LEVELS`, `CONTROL_IDS`, `GEMINI_BUCKETS`, `GEMINI_FREE_BUCKETS`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `SCHEMA_ENFORCEMENTS`, `COMPACTION_METERS`, `COMPACTION_TIMINGS`, `EGRESS_ON_BLOCK`, `TURN_STOP_KINDS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION` |
| Profiles | `ProfileDefinition`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `resolveTurn` |
| Tools | `defineTool`, `registerTool`, `registerTools`, `invokeTool`, `executeRegisteredTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `listBuiltinIds`, `listFunctionIds`, `resetTools`, `formatToolResult`, `TOOL_TYPES`, `TOOL_ACCESS`, `TOOL_LOAD_TIERS`, `TOOL_PERMISSION` |
| Structured | `getStructured`, `registerStructured` |
| Stop / resume | `ProfileResumeSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `AUTO_CONTINUE_DELAY_MS`, `CONTINUE_INSTRUCTION`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Profiles": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/schema.test.ts" }
      ]
    },
    "Turn lifecycle": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/mod.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/state.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/stream.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "source", "path": "src/kernel/registry/resolve.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Stream events": {
      "supports": [
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "source", "path": "src/kernel/engine/delta.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/delta.test.ts" }
      ]
    },
    "Registered tools": {
      "supports": [
        { "kind": "source", "path": "src/kernel/tools/mod.ts" },
        { "kind": "source", "path": "src/kernel/tools/execute.ts" },
        { "kind": "source", "path": "src/kernel/tools/resolve.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "contract_test", "path": "tests/kernel/tools.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Outputs and guardrails": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Compaction": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/compaction.ts" },
        { "kind": "source", "path": "src/kernel/engine/history-tokens.ts" },
        { "kind": "contract_test", "path": "tests/kernel/compaction.test.ts" }
      ]
    },
    "Stop and resume": {
      "supports": [
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turnStop.test.ts" }
      ]
    },
    "Validation": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/schema-validation.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    }
  }
}
```
