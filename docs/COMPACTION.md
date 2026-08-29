# Compaction

Optional, profile-driven compaction for managing conversation history when it
approaches a model's context window limit.

The kernel owns the trigger, the split logic, and the timing. The host (or the
kernel itself, for the easy path) owns the execution and reassembly.

## Why

Long-running conversations accumulate history that eventually exceeds the
model's context window. Before compaction infrastructure, every host app had to
build its own threshold detection, history splitting, compaction orchestration,
and timing decisions from scratch. The patterns are the same across apps; the
decisions (what model compacts, what the prompt says, how the output is shaped)
differ. THEORUM types those decisions into a config block and handles the
plumbing.

## Configuration

Compaction is configured per model in a profile's `model.config`:

```ts
const speakerModel: ModelSpec = {
  apiId: "gemini-3.5-flash",
  // ...existing model config...
  compaction: {
    maxHistoryTokens: 200_000, // token budget for conversation history
    compactAt: 0.75,           // fire when 75% full
    previousExchanges: 10,     // keep last 10 exchanges verbatim
    profile: "my.compactor",   // profile that does the compacting
    timing: "before",          // 'before' or 'after' the turn
  },
};
```

### `maxHistoryTokens`

Token budget for conversational history only — excludes system prompt, tool
schemas, and output headroom. The developer sets this based on the model's
context window minus their known fixed costs.

### `compactAt`

Fraction of `maxHistoryTokens` at which compaction fires. Must be in (0, 1).

### `previousExchanges`

How many recent exchanges to preserve verbatim after compaction. An exchange
starts at each user message and includes all subsequent messages (assistant
replies, tool calls, tool results) until the next user message.

Accepts three value ranges:

- **`>= 1` (integer)** — keep that many recent exchanges.
- **`(0, 1)` (fraction)** — retain exchanges that fit within this fraction of
  `maxHistoryTokens`, walking backwards from the most recent. Must be less than
  `compactAt`.
- **`0`** — compact everything; no tail is retained.

### `profile`

Profile id of the compaction agent. Must be registered before the owning
profile. This is a normal THEORUM profile — the developer controls the model,
system prompt, structured output schema, and everything about how compaction
works.

### `timing`

When compaction runs relative to the primary turn:

- **`'before'`** — the kernel compacts synchronously before the turn. The user
  pays latency on the triggering turn but gets a clean context.
- **`'after'`** — the kernel signals in the `done` event. The host runs
  compaction asynchronously. The user pays latency on the next turn only if
  compaction hasn't finished.

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

For structured compaction (e.g. a claims ledger), register a structured schema
and point the compaction profile's `outputs.structured` at it.

## Usage: easy path (`timing: 'before'`)

The kernel handles everything. Pass `lastInputTokens` from the previous turn's
`tokens` event into `TurnInput`, and the runner does the rest:

```ts
for await (const event of runTurn(req, provider)) {
  if (event.tokens) {
    // Thread this into the next turn's input.lastInputTokens
    lastInputTokens = event.tokens.input;
  }
  // handle other events...
}

// Next turn:
const nextReq: TurnRequest = {
  profile: "my.agent",
  input: {
    text: userMessage,
    history: conversationHistory,
    lastInputTokens, // from previous turn
  },
};
```

When the threshold is exceeded, the runner splits history, fires a nested
`runTurn` against the compaction profile, prepends the summary to the retained
tail, and proceeds with the real turn.

If the compaction profile uses a different provider, pass it via
`compactionProvider` on the `TurnRequest`.

## Usage: power-user path (`timing: 'after'`)

The kernel runs the turn normally. If the threshold is exceeded, the `done`
event carries a compaction signal:

```ts
for await (const event of runTurn(req, provider)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, inputTokens } = event.compaction;
    const spec = getCompactionSpecFromProfile(); // your lookup
    const { toCompact, toRetain } = splitForCompaction(history, spec);
    // Fire compaction asynchronously, store result, use it next turn
  }
}
```

This is for apps where:

- Compaction runs in the background after the turn (e.g. `edgeWaitUntil`)
- The output is a structured format (claims ledger, not plain summary)
- The host owns persistence, concurrency, and reassembly

## Exported API

| Export                | Kind     | Description                                      |
| --------------------- | -------- | ------------------------------------------------ |
| `CompactionSpec`      | type     | Config block on `ModelSpec`                       |
| `CompactionSignal`    | type     | Signal on `TurnEvent.compaction` (done events)    |
| `CompactionSplit`     | type     | Return type of `splitForCompaction`               |
| `compactionNeeded`    | function | `(lastInputTokens, spec) => boolean`              |
| `splitForCompaction`  | function | `(history, spec) => { toCompact, toRetain }`      |

## Validation

All config is validated at `registerProfile` time:

- `compactAt` must be in (0, 1)
- `previousExchanges` as a fraction must be < `compactAt`
- `previousExchanges` >= 1 must be an integer
- `maxHistoryTokens` must be > 0
- The named compaction profile must already be registered

Misconfiguration fails fast at startup, not at runtime.
