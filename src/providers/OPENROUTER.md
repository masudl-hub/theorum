# OpenRouter (`theorum/openrouter`)

Direct OpenRouter provider adapter and OpenAI-compatible payload helpers.
Prefer `createProvider(profile, { openRouter })` from `theorum` /
`theorum/providers` for turn execution. Use this entry when building payloads
or constructing the adapter outside the runner.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/openrouter` / `jsr:@theorum/core/openrouter` |
| Module | `src/providers/openrouter-mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/providers/openrouter.ts` | Chat adapter (`createOpenRouterProvider`) |
| `src/providers/openrouter-mod.ts` | Public barrel |
| `src/providers/openrouter-payload.ts` | Payload + model resolution |

Importing this entry loads `@openrouter/ai-sdk-provider` / `ai` **immediately**.
The lazy path through `createProvider` defers that until first `complete`.

## Configuration

`OpenRouterConfig` (host-supplied):

| Field | Role |
| --- | --- |
| `apiKey` | Bearer credential |
| `baseUrl` | Optional API base override |
| `siteUrl` / `siteName` | Optional HTTP-Referer / X-Title style metadata |
| `fetch` | Optional custom fetch |
| `modelMap` | Optional map from THEORUM model id → OpenRouter model string |

## Model resolution

`resolveOpenRouterModel(modelId, customMap?, wire?)` precedence:

| Step | Source |
| --- | --- |
| 1 | `customMap[modelId]` |
| 2 | `wire.openRouterId` |
| 3 | `wire.apiId` when it contains `/` |
| 4 | `google/${wire.apiId}` when `apiId` set |
| 5 | Pass-through model id string |

## Payloads

`toOpenRouterPayload` maps `ProviderCompleteRequest` → OpenAI chat-completions body:

| Area | Mapped from |
| --- | --- |
| Messages | History + multimodal parts |
| Tools | Catalog builtins + dynamic tools |
| Structured output | `responseFormat` / JSON schema |
| Thinking | `reasoning.effort` |

## Adapter behavior

| Concern | Behavior |
| --- | --- |
| Entry | `createOpenRouterProvider(config)` → `ModelProvider` |
| Stream | Yields normalized `TurnEvent`s |
| Stop | `done.stop` via `turnStopFromOpenRouter` |

## Exported API

| Export | Kind |
| --- | --- |
| `createOpenRouterProvider` | function |
| `OpenRouterConfig` | type |
| `resolveOpenRouterModel` | function |
| `toOpenRouterPayload` | function |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter-mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Configuration": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter-payload.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter-payload.test.ts" }
      ]
    },
    "Model resolution": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter-payload.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter-payload.test.ts" }
      ]
    },
    "Payloads": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter-payload.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter-payload.test.ts" }
      ]
    },
    "Adapter behavior": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter-mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter.test.ts" }
      ]
    }
  }
}
```
