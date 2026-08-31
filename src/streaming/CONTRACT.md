# Streaming (`theorum/streaming`)

Structured-output streaming helpers and turn-stop classification re-exports for
hosts that want a narrow import without taking the full kernel barrel.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/streaming` / `jsr:@theorum/core/streaming` |
| Module | `src/streaming/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/streaming/readStreamingJsonStringField.ts` | Incomplete JSON string preview |
| `src/streaming/mod.ts` | Barrel + stop re-exports |

Stop source of truth: [`../kernel/CONTRACT.md`](../kernel/CONTRACT.md)
(`src/kernel/stop.ts`).

## Streaming JSON preview

`readStreamingJsonStringField(jsonText, key)` reads one string field from
**incomplete** JSON while structured output streams as text deltas.

```ts
const preview = readStreamingJsonStringField(buffer, "mermaid");
// returns decoded prefix even before closing quote
```

| Behavior | Detail |
| --- | --- |
| Locator | `"key": "` pattern |
| Escapes | `\n`, `\t`, `\uXXXX`, … |
| Incomplete buffer | Returns prefix for live UI preview |
| Missing key | `null` |

Does not validate full JSON documents.

## Stop re-exports

| Category | Exports |
| --- | --- |
| Types | `TurnStop`, `TurnStopKind`, `TurnContinueFrom`, `ProfileResumeSpec` |
| Constants | `CONTINUE_INSTRUCTION`, `DEFAULT_AUTO_CONTINUE`, `AUTO_CONTINUE_DELAY_MS` |
| Helpers | `isResumeableStop`, `shouldAutoContinue`, `isUserCancelledStop`, mappers |
| Errors | `GenerationStopError`, `isGenerationStopError` |

Behavioral contract: kernel **Stop and resume** section.

## Exported API

| Group | Symbols |
| --- | --- |
| Streaming JSON | `readStreamingJsonStringField` |
| Stop / resume (re-export from `kernel/stop.ts`) | `ProfileResumeSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `AUTO_CONTINUE_DELAY_MS`, `CONTINUE_INSTRUCTION`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenRouter` |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/streaming/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/streaming/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Streaming JSON preview": {
      "supports": [
        { "kind": "source", "path": "src/streaming/readStreamingJsonStringField.ts" },
        { "kind": "contract_test", "path": "tests/streaming/readStreamingJsonStringField.test.ts" }
      ]
    },
    "Stop re-exports": {
      "supports": [
        { "kind": "source", "path": "src/streaming/mod.ts" },
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/streaming/turnStop.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/streaming/mod.ts" },
        { "kind": "contract_test", "path": "tests/streaming/readStreamingJsonStringField.test.ts" }
      ]
    }
  }
}
```
