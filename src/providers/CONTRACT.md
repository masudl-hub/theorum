# Providers (`theorum/providers`)

Single door for constructing a `ModelProvider` bound to a profile. Credentials
and runtime endpoints are always host-supplied arguments — THEORUM does not read
environment variables and does not ship `.env` files.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/providers` / `jsr:@theorum/core/providers` |
| Module | `src/providers/mod.ts` |
| Also on | Root `theorum` re-exports `createProvider` |

## Ownership

Owns every module under `src/providers/` **except** OpenRouter-specific modules
in [`OPENROUTER.md`](./OPENROUTER.md).

| Module | Role (internal) |
| --- | --- |
| `create-provider.ts` | Public factory + lazy OpenRouter chat wrapper |
| `provider.ts` | Google Interactions streaming adapter |
| `interactions.ts` | Interactions payload / step wiring |
| `speech.ts` | OpenRouter `/audio/speech` + Interactions audio paths |
| `local.ts` | OpenAI-compat SSE for Ollama / llama.cpp / vLLM / LM Studio |
| `keys.ts` | Gemini vault transport types |
| `sse.ts` | Shared SSE line parser |
| `pcm.ts` | PCM → WAV for Interactions speech output |
| `gemini-tape.ts` / `google-tap.ts` | Test / tap hooks (not public exports) |
| `expose-for-tests.ts` | `THEORUM_TEST_INTERNALS=1` gated test surface |

## Package boundary

| Rule | Detail |
| --- | --- |
| No `.env` in repo | Hosts pass credentials explicitly |
| No ambient env reads | `OLLAMA_HOST` resolved by host → `local.baseUrl` |
| No key templates | Business apps own secret storage |
| Traces | Host-injected on `runTurn`, not here |

## createProvider

```ts
const provider = createProvider(profile, {
  gemini: { vault: { freeA, freeB, freeC, paid }, fetch? },
  openRouter: { apiKey, baseUrl?, siteUrl?, siteName?, fetch?, modelMap?, voice? },
  local: { baseUrl?, fetch? },
})
```

Routing table:

| protocol | provider | Requires | Transport |
| --- | --- | --- | --- |
| `geminiInteractions` | `google` | `options.gemini` | Interactions API (chat / image / speech) |
| `openAi` | `openrouter` | `options.openRouter` | Lazy chat adapter or `speech.ts` when `outputs.speech` |
| `openAi` | `local` | optional `options.local` | `POST /v1/chat/completions` SSE |

Errors:

- Missing credential block → `TheorumError` naming the required option.
- Unsupported pair → `TheorumError` with protocol/provider in the message.

OpenRouter Vercel AI SDK loads **only** on first `complete` for `openAi` +
`openrouter` chat. Google and local never import it.

## Google Interactions

`createInteractionsProvider(geminiTransport)` streams normalized `TurnEvent`s.

| Concern | Behavior |
| --- | --- |
| History | `user_input` / `model_output` steps |
| Multimodal | `image` / `audio` / `video` / `document` parts |
| Structured | `responseFormat` JSON schema when enforced |
| Output modes | Image / speech / structured are mutually exclusive |
| Tools | Catalog `interactionsType` + plugins |
| Stop | `turnStopFromInteractionStatus` on terminal status |

## Local provider

`createLocalProvider` / `DEFAULT_LOCAL_BASE_URL` (`http://127.0.0.1:11434`). Hosts
resolve `OLLAMA_HOST` (or similar) themselves and pass `baseUrl` here — THEORUM
does not read environment variables for local endpoints (see module header in
`local.ts`, not `docs/SECRETS.md`).

```ts
local: {
  baseUrl: "http://127.0.0.1:11434", // no trailing slash
  fetch: customFetch,
}
```

- Raw `fetch` + `sse.ts` — no SDK.
- Accumulates streaming tool calls; maps `finish_reason` through
  `turnStopFromOpenRouter`.
- Supports multimodal user content when the server accepts OpenAI-style parts.

## Speech roles

When `profile.outputs.speech` is defined and protocol/provider is OpenRouter
OpenAI, `createProvider` returns `createSpeechProvider`:

| Transport | Path | Notes |
| --- | --- | --- |
| OpenAI | `/audio/speech` | `mp3` allowed via `response_format` |
| Interactions | audio `responseFormat` | PCM → WAV; `mp3` rejected at resolve |

Fallback `openRouter.voice` when `outputs.speech.voice` omitted.

## Gemini transport

```ts
createProvider(profile, {
  gemini: { vault: { freeA, freeB, freeC, paid } },
})
```

| Piece | Role |
| --- | --- |
| `GeminiTransport` | Vault + optional `fetch` |
| Buckets | `freeA`, `freeB`, `freeC`, `paid` |
| Selection | `model.key` / `ModelSpec.key` / `keyBuiltins` |

Overflow to `paid` is host policy, not inferred here.

## Exported API

From `src/providers/mod.ts` only:

| Export | Kind |
| --- | --- |
| `createProvider` | function |
| `CreateProviderOptions` | type |
| `GeminiTransport`, `GeminiVault` | types |
| `createLocalProvider` | function |
| `LocalProviderConfig` | type |
| `DEFAULT_LOCAL_BASE_URL` | const |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Package boundary": {
      "supports": [
        { "kind": "source", "path": "src/providers/create-provider.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    },
    "createProvider": {
      "supports": [
        { "kind": "source", "path": "src/providers/create-provider.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    },
    "Google Interactions": {
      "supports": [
        { "kind": "source", "path": "src/providers/provider.ts" },
        { "kind": "source", "path": "src/providers/interactions.ts" },
        { "kind": "contract_test", "path": "tests/providers/interactions.test.ts" }
      ]
    },
    "Local provider": {
      "supports": [
        { "kind": "source", "path": "src/providers/local.ts" },
        { "kind": "contract_test", "path": "tests/providers/local.test.ts" }
      ]
    },
    "Speech roles": {
      "supports": [
        { "kind": "source", "path": "src/providers/speech.ts" },
        { "kind": "contract_test", "path": "tests/providers/speech.test.ts" }
      ]
    },
    "Gemini transport": {
      "supports": [
        { "kind": "source", "path": "src/providers/keys.ts" },
        { "kind": "contract_test", "path": "tests/providers/keys.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    }
  }
}
```
