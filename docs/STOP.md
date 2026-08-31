# Turn stop and resume

Providers end turns for many reasons (completed, length, tool call, filter,
network drop). THEORUM normalizes those into `TurnStop` on terminal `done`
events so hosts can decide Continue / auto-continue without parsing each
adapter.

## `done.stop`

Adapters attach a `stop` when the turn ends cleanly enough to classify:

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | Model requested tool use |
| `filtered` | Content filter |
| `provider_error` | Upstream failure |
| `cancelled` | User / host abort |
| `stream_incomplete` | Stream ended without a terminal reason (tunnel drop, etc.) |

OpenRouter maps `finish_reason` (+ optional native reason). Google Interactions
maps terminal `status`. Local OpenAI-compat servers use the same OpenRouter
finish-reason mapping. Hosts classify client SSE drops with
`turnStopFromClientStreamEnd`.

## Profile resume policy

Under `outputs.resume`:

```ts
outputs: {
  structured: null,
  resume: {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  },
}
```

- `allowContinue` — kinds eligible for a Continue CTA / `continueFrom` turn
  (default: length, stream_incomplete, provider_error).
- `autoContinue` — kinds the host may silently resume **once** after a short
  pause (`AUTO_CONTINUE_DELAY_MS`, 1500). Kernel does not loop; hosts call
  `continueFrom` at most once. User `cancelled` is never auto-continued.

Helpers: `isResumeableStop`, `shouldAutoContinue`, `isUserCancelledStop`.

## Continuing a turn

Pass `continueFrom` on the next `TurnRequest`. The kernel appends the fixed
`CONTINUE_INSTRUCTION` (do not invent per-app continue prompts):

```ts
for await (const event of runTurn({
  profile: "my.agent",
  input: { text: "" },
  continueFrom: {
    stop: previousDone.stop,
    partialText: bufferedAssistantText,
    // optional: partialArtifact
  },
}, provider)) {
  // …
}
```

## Errors

`GenerationStopError` carries a `stop` for hosts that prefer throw/catch over
stream events. `isGenerationStopError` narrows it.

## Exported API

| Export | Kind | Description |
| --- | --- | --- |
| `TurnStop` / `TurnStopKind` | type | Normalized stop on `done` |
| `TurnContinueFrom` | type | Partial state for resume |
| `ProfileResumeSpec` | type | `outputs.resume` policy |
| `CONTINUE_INSTRUCTION` | const | Fixed continue system text |
| `DEFAULT_AUTO_CONTINUE` | const | Default one-shot auto-continue kinds |
| `AUTO_CONTINUE_DELAY_MS` | const | Suggested pause before auto-continue |
| `isResumeableStop` / `shouldAutoContinue` / `isUserCancelledStop` | function | Host policy helpers |
| `turnStopFromOpenRouter` / `turnStopFromInteractionStatus` / `turnStopFromClientStreamEnd` | function | Provider / client mappers |
| `GenerationStopError` / `isGenerationStopError` | class / function | Optional throw path |
