# Theorum Provider Configuration Guide

Theorum does not own secrets and does not read environment variables.

Host applications own credentials, runtime configuration, and secret storage. Theorum receives provider configuration as explicit function arguments.

## 1. Package Boundary

- Do not create `.env` files in this repository.
- Do not commit key templates to this repository.
- Do not teach Theorum to discover keys from the shell or process environment.
- Business applications pass credentials into `createProvider`.

## 2. Single door: `createProvider`

```ts
import { createProvider, runTurn } from 'theorum';

const provider = createProvider(profile, {
  // geminiInteractions / google
  gemini: {
    vault: {
      freeA: hostResolvedFreeAKey,
      freeB: hostResolvedFreeBKey,
      freeC: hostResolvedFreeCKey,
      paid: hostResolvedPaidKey,
    },
  },
  // openAi / openrouter (chat or speech role — same credentials)
  openRouter: {
    apiKey: hostResolvedOpenRouterKey,
  },
  // openAi / local (Ollama, llama.cpp, vLLM, LM Studio, …)
  // Hosts that honor OLLAMA_HOST should resolve it themselves — THEORUM does not.
  local: {
    baseUrl: hostResolvedLocalBaseUrl, // optional; default http://127.0.0.1:11434
  },
});

for await (const event of runTurn({ profile: profile.id, input: { text: '…' } }, provider)) {
  // …
}
```

`createProvider` picks the transport from `profile.model.protocol` / `provider` (and whether the profile is a speech role). Hosts do not choose a separate speech constructor. OpenRouter's Vercel AI SDK dependency loads only when an `openAi` + `openrouter` chat provider first calls `complete` — Google and local paths never import it.

## 3. Tracing

Tracing is silent by default. Hosts opt in by passing a sink to `runTurn`.

```ts
import { createProvider, jsonlSink, runTurn } from 'theorum';

const provider = createProvider(profile, { openRouter: { apiKey: hostResolvedOpenRouterKey } });

for await (const event of runTurn(request, provider, jsonlSink(hostTraceDir))) {
  // stream events
}
```

For live verification, pass credentials explicitly:

```bash
deno run --allow-net scripts/verify-live.ts --api-key "<host-resolved-key>"
```
