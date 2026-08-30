# Compaction

Optional, profile-driven compaction for managing conversation history when it
approaches a model's context window limit.

The kernel owns the trigger, the split logic, and the timing. The host (or the
kernel itself, for the easy path) owns the execution and reassembly.

## Why

Long-running conversations accumulate history that eventually exceeds the
model's context window. Compaction types the trigger and split into a config
block; the host still owns how summaries are shaped and persisted.

## Configuration

Compaction is configured per model in a profile's `model.config`:

```ts
const speakerModel: ModelSpec = {
  apiId: "gemini-3.5-flash",
  // ...existing model config...
  compaction: {
    maxTokens: 2000,           // budget for the chosen meter
    compactAt: 0.75,           // fire when 75% full
    previousExchanges: 8,      // keep last 8 exchanges verbatim
    profile: "my.compactor",   // profile that does the compacting
    timing: "after",           // 'before' or 'after' the turn
    meter: "history",          // default; or "input"
  },
};
```

### `meter`

What the threshold compares:

| Value | Meaning |
| --- | --- |
| `'history'` (default) | Conversational history only. Host `input.historyTokens`, else local estimate of `input.history`. Excludes system, tool schemas, and this-turn attachments. |
| `'input'` | Full-prompt provider input tokens. For `timing: 'before'`, pass previous turn's usage as `input.inputTokens`. For `timing: 'after'`, the kernel uses this turn's `tokens.input`. |

Provider `tokens` events always stay on the stream for billing / observability.
With `meter: 'history'` they do **not** gate compaction. With `meter: 'input'`
they (or host-threaded `inputTokens`) **do**.

### `maxTokens`

Budget compared as `tokens > compactAt * maxTokens`.

- With `meter: 'history'`: set from the model's context window minus known fixed
  costs (system, tools, output headroom).
- With `meter: 'input'`: set as a full-prompt ceiling (or baseline + headroom).
  Small history-style budgets (e.g. 2000) will fire often if system + tools are
  large — that is expected for this meter.

### How `meter: 'history'` counts

1. If the host sets `input.historyTokens`, that value is used.
2. Otherwise the kernel estimates from `input.history` (or `[]`):
   - **Text** — tiktoken `o200k_base` (via `gpt-tokenizer`) over `content`,
     text `parts`, and `tool_calls` arguments. Declared local BPE; Gemini has
     no open JS tokenizer — pass `historyTokens` for Gemini `countTokens`.
     The BPE ranks load **lazily on first text estimate** — not when the package
     is imported. `meter: 'input'`, host `historyTokens`, empty history, and
     media-only estimates never load the tokenizer.
   - **Media parts** — minimum stubs when size/duration are unknown (not
     payload bytes). Image/document: 258 (one still-image / page unit).
     Audio: 32 (1s @ 32/s). Video: 263 (1s @ 263/s). Larger Gemini 2.x images
     are 258×tiles; Gemini 3 uses `media_resolution` budgets (often 560–1120).
     Prefer `historyTokens` when the host knows better.
   - Current-turn `attachments` / `voice` are **not** history.

The same history estimator is used by `splitForCompaction` for fractional
`previousExchanges` (integer / `0` splits do not need the tokenizer). Empty or
missing history is **0** (does not fire).

### `compactAt`

Fraction of `maxTokens` at which compaction fires. Must be in (0, 1).

### `previousExchanges`

How many recent exchanges to preserve verbatim after compaction. An exchange
starts at each user message and includes all subsequent messages (assistant
replies, tool calls, tool results) until the next user message.

- **`>= 1` (integer)** — keep that many recent exchanges.
- **`(0, 1)` (fraction)** — retain exchanges that fit within this fraction of
  `maxTokens` (history estimate), walking backwards. Must be less than
  `compactAt`.
- **`0`** — compact everything; no tail is retained.

### `profile`

Profile id of the compaction agent. Must be registered before the owning
profile.

### `timing`

- **`'before'`** — compact synchronously before the turn.
- **`'after'`** — signal on the `done` event; host runs compaction async.

### `trigger`

Optional custom gate. When set, it **replaces** the default
`tokens > compactAt * maxTokens` check. The kernel still resolves `{ meter,
tokens }` first and passes them as `CompactionTriggerContext` so the host can
combine token pressure with other signals (e.g. free RAM):

```ts
compaction: {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  profile: "my.compactor",
  timing: "after",
  trigger: (ctx) =>
    ctx.tokens > ctx.compactAt * ctx.maxTokens || hostRamPressure(),
},
```

Sync and async triggers are both accepted. Omit `trigger` to keep the default
threshold.

## The compaction profile

A compaction profile is a standard THEORUM profile. A simple summarizer:

```ts
registerProfile(
  defineProfile({
    id: "my.compactor",
    identity: {
      handle: "Compactor",
      system: "Summarize this conversation concisely. Preserve unresolved "
        + "issues, decisions made, and key facts. Drop greetings and filler.",
    },
    model: {
      ...modelAllow("gemini35FlashLite"),
      thinking: "minimal",
      maxSteps: 1,
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: "my.summary.schema" },
    guardrails: {
      canary: false,
      sanitizeInput: false,
      redactSensitive: false,
    },
  }),
);
```

## Usage: `meter: 'history'` (default)

```ts
const nextReq: TurnRequest = {
  profile: "my.agent",
  input: {
    text: userMessage,
    history: conversationHistory,
    // optional: historyTokens: hostHistoryCount,
  },
};
```

## Usage: `meter: 'input'`

```ts
// timing: 'before' — thread previous turn's full-prompt usage
input: {
  text: userMessage,
  history: conversationHistory,
  inputTokens: previousTokensInput,
}

// timing: 'after' — kernel reads this turn's tokens.input automatically
for await (const event of runTurn(req, provider)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, tokens, meter, promptTokens } = event.compaction;
    // meter === 'input'; tokens === promptTokens (when known)
  }
}
```

If the compaction profile uses a different provider, pass `compactionProvider`
on the `TurnRequest`.

## Exported API

| Export | Kind | Description |
| --- | --- | --- |
| `CompactionSpec` | type | Config on `ModelSpec` |
| `CompactionMeter` | type | `'history' \| 'input'` |
| `CompactionSignal` | type | `done.compaction`: `meter`, `tokens`, optional `promptTokens`, `history` |
| `CompactionSplit` / `CompactionTokens` | type | Split result / resolved meter count |
| `resolveHistoryTokens` | async function | Host `historyTokens` or local history estimate |
| `resolveCompactionTokens` | async function | Resolve `{ meter, tokens }` for a turn |
| `estimateHistoryTokens` | async function | tiktoken `o200k_base` + media stubs (lazy BPE) |
| `HISTORY_TEXT_ENCODING` | const | `'o200k_base'` |
| `HISTORY_MEDIA_TOKENS` | const | Media minima: image/document 258, audio 32, video 263 |
| `compactionNeeded` | function | `(tokens, spec) => boolean` |
| `shouldCompact` | async function | Custom `trigger` or `compactionNeeded` |
| `splitForCompaction` | async function | `(history, spec) => { toCompact, toRetain }` |

## Validation

At `registerProfile` time:

- `maxTokens` must be > 0
- `compactAt` must be in (0, 1)
- `previousExchanges` as a fraction must be < `compactAt`
- `previousExchanges` >= 1 must be an integer
- `meter`, when set, must be `'history'` or `'input'`
- The named compaction profile must already be registered

## 0.1.13

- Default meter is **history** (local BPE + media stubs, or host `historyTokens`).
- Optional `meter: 'input'` gates on full-prompt provider usage.
- Budget field is `maxTokens` (not `maxHistoryTokens`).
- `CompactionSignal` uses `meter` + `tokens` (no deprecated aliases).
- Optional `trigger` replaces the default threshold check.
- History BPE (`gpt-tokenizer` / `o200k_base`) loads lazily on first text estimate.
