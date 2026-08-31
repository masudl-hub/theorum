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
| Re-exports | `theorum/streaming` re-exports stop helpers; source of truth stays here |

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

Multimodal ingress uses provider-neutral `InteractionPart` values;
`InteractionMediaPart.type` is `MediaInputKind` (`image` | `audio` | `video` |
`document`). MIME → kind mapping lives in `mediaKindForMime` (`catalog.ts`).

`model.protocol` is `'geminiInteractions' | 'openAi'`.
`model.provider` is `'google' | 'openrouter' | 'local'`.
Every id in `allow` must exist in `config`. Each `ModelSpec` carries wire ids
(`apiId`, optional `openRouterId`), `thinking` / `summaries` maps,
`thinkingLevels`, `maxOutputTokens`, `temperature`, `keyBuiltins`, optional
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

1. **Resolve** — `resolveTurn` picks model, thinking, tools, structured schema,
   streaming flags, canary token.
2. **Sanitize** — `sanitizeTurnRequest` strips injection/sensitive spans per
   profile guardrails (unless disabled).
3. **Compaction (before)** — when `timing: 'before'` and threshold fires, kernel
   runs the compaction profile turn synchronously, then continues with trimmed
   history.
4. **Canary bind** — `bindCanary` embeds the per-turn canary in system text when
   `guardrails.canary` is enabled.
5. **Provider stream** — `provider.complete` yields partial events; runner may
   gate thoughts/media per `outputs.streaming`.
6. **Tool loop** — while under `maxSteps`, tool calls execute via `executeTool`
   / `invokeFromUi`; results feed the next step.
7. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`.
8. **Egress** — `guardrails.egress.enforce` may block, refuse, or retry with
   repair guidance before releasing user-visible text.
9. **Trace** — optional sink receives a `TraceRecord`; failures are swallowed.
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
| `evidence` | Provider-native evidence attachments |
| `tokens` | `input` / `output` / `total` usage (billing; may gate `meter: 'input'`) |
| `done` | Terminal: `stop`, `tokens`, `compaction`, final text pointer |
| `error` | Public-safe failure (`toErrorEvent`) |

`TurnHistoryMessage` preserves `role`, `content`, `parts`, `tool_calls`,
`tool_call_id`, and opaque `metadata` across turns.

## Dynamic tools

Per-turn tools sit under profile `tools.allow`:

```ts
TurnRequest: {
  dynamicTools?: DynamicToolDeclaration[];
  dynamicToolLoader?: DynamicToolLoader; // T2 expansion
}
```

| Field | Role |
| --- | --- |
| `loadTier` | `T0` / `T1` / `T2` visibility strategy (host-owned) |
| `permissionTier` | `auto` / `session_consent` / `always_confirm` |
| `parameters` | JSON Schema fragment sent to the provider |

`executeTool` runs catalogued builtins/custom tools. Conflicts (e.g. Google maps vs
search) are enforced via catalog `conflictsWith`.

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

Mappers: `turnStopFromOpenRouter`, `turnStopFromInteractionStatus`,
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
| Catalog | `CATALOG`, `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaKindForMime`, `getTool`, `listBuiltinIds`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelSpec`, `resetTools` |
| Profiles | `ProfileDefinition`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `resolveTurn` |
| Structured + tools | `getStructured`, `registerStructured`, `executeTool` |
| Stop / resume | `ProfileResumeSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `AUTO_CONTINUE_DELAY_MS`, `CONTINUE_INSTRUCTION`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenRouter` |

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
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
      ]
    },
    "Turn lifecycle": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/mod.ts" },
        { "kind": "source", "path": "src/kernel/registry/resolve.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Stream events": {
      "supports": [
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Dynamic tools": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/tools.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/tools.ts" },
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
        { "kind": "contract_test", "path": "tests/streaming/turnStop.test.ts" }
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
