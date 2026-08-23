# Theorum Provider Configuration Guide

Theorum does not own secrets and does not read environment variables.

Host applications own credentials, runtime configuration, and secret storage. Theorum receives provider configuration as explicit function arguments.

## 1. Package Boundary

- Do not create `.env` files in this repository.
- Do not commit key templates to this repository.
- Do not teach Theorum to discover keys from the shell or process environment.
- Business applications pass credentials into provider constructors or transport objects.

## 2. OpenRouter

```ts
import { createOpenRouterProvider } from '@theorum/core/openrouter';

const provider = createOpenRouterProvider({
  apiKey: hostResolvedOpenRouterKey,
});
```

## 3. Google Interactions

```ts
import { createInteractionsProvider } from '@theorum/core/providers';

const provider = createInteractionsProvider({
  vault: {
    freeA: hostResolvedFreeAKey,
    freeB: hostResolvedFreeBKey,
    freeC: hostResolvedFreeCKey,
    paid: hostResolvedPaidKey,
  },
});
```

## 4. Tracing

Tracing is silent by default. Hosts opt in by passing a sink to `runTurn`.

```ts
import { jsonlSink, runTurn } from '@theorum/core';

for await (const event of runTurn(request, provider, jsonlSink(hostTraceDir))) {
  // stream events
}
```

For live verification, pass credentials explicitly:

```bash
deno run --allow-net scripts/verify-live.ts --api-key "<host-resolved-key>"
```
