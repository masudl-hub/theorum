```text
 _______  __   __  _______  _______  ______    __   __  __   __
|       ||  | |  ||       ||       ||    _ |  |  | |  ||  |_|  |
|_     _||  |_|  ||    ___||   _   ||   | ||  |  | |  ||       |
  |   |  |       ||   |___ |  | |  ||   |_||_ |  |_|  ||       |
  |   |  |       ||    ___||  |_|  ||    __  ||       ||       |
  |   |  |   _   ||   |___ |       ||   |  | ||       || ||_|| |
  |___|  |__| |__||_______||_______||___|  |_||_______||_|   |_|
```

# THEORUM: The Flat Agent Kernel

> **"Profiles describe the contract. Providers move bytes. The runner enforces the turn."**

THEORUM is a compact TypeScript agent kernel for apps that need deterministic agent execution without embedding product logic inside the runtime. It gives a host application one runner, typed profiles, multimodal input normalization, dynamic tool dispatch, provider adapters, trace sinks, and guardrail hooks.

The package is intentionally **not** an agent product. It ships no app profiles, no prompts, no secrets, no database policy, no business rules, and no channel-specific UX. Those belong in the host application.

---

## Core Principles

```toml
[kernel_contract]
profiles = "Host-owned declarations for model, inputs, outputs, tools, and guardrails"
runner = "Single deterministic execution path for one agent turn"
providers = "createProvider routes protocol/provider; adapters stay internal"
tools = "Profile allowlist ceiling plus per-turn dynamic declarations"
egress = "Typed host hook for outbound disclosure checks and repair loops"
traces = "Host-injected sinks; no environment variables or bundled destinations"

[non_goals]
app_profiles = "No bundled assistants, demos, product personas, or business tasks"
secrets = "No .env files, no ambient key reads in the kernel"
realtime_voice = "Not included yet; persistent duplex sessions stay host-owned"
product_copy = "No channel wording, refusal copy, iMessage/Alexa/Web policy, or UX defaults"
```

---

## Architecture

THEORUM is organized around a deliberately small execution boundary.

```mermaid
flowchart TD
    subgraph Host["Host application"]
        Profile["Profiles"]
        Schemas["Structured schemas"]
        Tools["Tool handlers"]
        Keys["Provider keys"]
        TraceSink["Trace sink"]
        Policy["Business rules"]
    end

    subgraph Kernel["THEORUM"]
        Resolve["resolveTurn"]
        Guard["sanitize + canary + egress"]
        Runner["runTurn"]
        ToolLoop["dynamic tool loop"]
        Repair["repair attempts"]
    end

    subgraph Providers["Provider adapters"]
        OR["OpenRouter chat"]
        GI["Google Interactions"]
        Speech["Speech (Interactions or /audio/speech)"]
    end

    Profile --> Resolve
    Schemas --> Resolve
    Tools --> ToolLoop
    Keys --> Providers
    TraceSink --> Runner
    Policy --> Guard
    Resolve --> Runner
    Guard --> Runner
    Runner --> Providers
    Providers --> Runner
    Runner --> TraceSink
```

Hosts bind transports with `createProvider(profile, { gemini, openRouter })`. One door; protocol/provider (and speech role) pick the adapter.

### Turn Lifecycle

```mermaid
stateDiagram-v2
    [*] --> ResolveProfile: host sends TurnRequest
    ResolveProfile --> NormalizeInput: profile input rules
    NormalizeInput --> BindBoundary: canary + user data fencing
    BindBoundary --> ProviderStream: ModelProvider.complete
    ProviderStream --> ToolDispatch: tool event
    ToolDispatch --> ProviderStream: autonomous loop continues
    ProviderStream --> EgressGate: final candidate
    EgressGate --> RepairTurn: blocked + retry budget
    RepairTurn --> ProviderStream
    EgressGate --> ValidateOutput: clear
    ValidateOutput --> EmitEvents: text/media/structured/tokens/done
    EmitEvents --> Trace: host sink receives audit record
    Trace --> [*]
```

---

## Install

### Deno / JSR

```bash
deno add jsr:@theorum/core
```

```ts
import { defineProfile, registerProfile, runTurn } from "jsr:@theorum/core";
```

### npm

```bash
npm install theorum
```

```ts
import { defineProfile, registerProfile, runTurn } from "theorum";
```

---

## Minimal Example

This example uses a local mock provider so it runs without secrets. Real provider keys should be passed into the provider adapter by the host application.

```ts
import {
  defineProfile,
  registerProfile,
  runTurn,
  type ModelProvider,
  type TurnEvent,
} from "jsr:@theorum/core";

const profile = defineProfile({
  id: "assistant.basic",
  identity: {
    handle: "assistant",
    system: "Answer plainly.",
  },
  model: {
    protocol: "openAi",
    provider: "openrouter",
    allow: ["gemini35FlashLite"],
    config: {
      gemini35FlashLite: {
        apiId: "gemini-3.5-flash-lite",
        thinking: { on: "high", off: "minimal" },
        thinkingLevels: ["minimal", "low", "medium", "high"],
        summaries: { on: "auto", off: "none" },
        maxOutputTokens: 8192,
        temperature: 1,
        keyBuiltins: [],
      },
    },
    thinking: "minimal",
    maxSteps: 1,
  },
  outputs: {
    streaming: { streamThoughts: false },
  },
  guardrails: {
    quota: { perDay: 100 }, // Optional. Omit when the host owns metering.
  },
});

registerProfile(profile);

const provider: ModelProvider = {
  async *complete(): AsyncIterable<TurnEvent> {
    yield { type: "text", text: "The turn completed." };
    yield { type: "tokens", tokens: { input: 8, output: 4, total: 12 } };
    yield { type: "done" };
  },
};

for await (const event of runTurn(
  { profile: "assistant.basic", input: { text: "Ping" } },
  provider,
)) {
  console.log(event);
}
```

---

## Dynamic Tools

THEORUM separates tool concerns into three layers.

| Layer | Owner | Purpose |
| :--- | :--- | :--- |
| **Access** | Profile | Hard ceiling: the agent cannot use a tool outside `profile.tools.allow`. |
| **Visibility** | Turn request | Per-turn declarations: T0/T1/T2 schemas can be passed or loaded dynamically. |
| **Permission** | Host app | `auto`, `session_consent`, and `always_confirm` determine whether execution pauses. |

```ts
const dynamicTools = [
  {
    name: "lookup_order",
    description: "Fetch order state from the host application.",
    loadTier: "T1",
    permissionTier: "session_consent",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
    handler: async (args) => ({
      status: "ok",
      finding: "Order is in transit.",
      data: { orderId: args.orderId, state: "in_transit" },
    }),
  },
] as const;
```

The host owns the handler and authorization state. The kernel only enforces the declared contract.

---

## Guardrails and Egress

Inbound and outbound safety are generic kernel hooks.

```ts
const guardedProfile = defineProfile({
  id: "assistant.guarded",
  model: {
    allow: ["gemini35FlashLite"],
    config: {
      gemini35FlashLite: {
        apiId: "gemini-3.5-flash-lite",
        thinking: { on: "high", off: "minimal" },
        thinkingLevels: ["minimal", "low", "medium", "high"],
        summaries: { on: "auto", off: "none" },
        maxOutputTokens: 8192,
        temperature: 1,
        keyBuiltins: [],
      },
    },
  },
  guardrails: {
    egress: {
      onBlock: "reject_to_agent",
      maxRetries: 2,
      enforce: ({ text, canary }) => {
        if (canary && text.includes(canary)) {
          return {
            blocked: true,
            text: "",
            hits: ["canary_token_leak"],
            rejectionMessage: "Remove private runtime tokens from the reply.",
          };
        }
        return { blocked: false, text };
      },
    },
  },
});
```

The egress function is host-owned. One application may block internal tool names, another may block regulated disclosures, and another may disable egress entirely for a trusted development profile.

Quota is optional. If a profile omits `guardrails.quota`, the quota helper returns `not_configured` so the host can decide whether that route should be unmetered, rejected, or handled by a separate rate limiter.

---

## Provider Adapters

THEORUM includes provider adapters but does not own credentials. Bind them with one door:

```ts
import { createProvider, runTurn } from "jsr:@theorum/core";

const provider = createProvider(profile, {
  gemini: { vault: hostGeminiKeyVault, fetch },
  openRouter: { apiKey: hostSecrets.openRouterApiKey },
});

for await (const event of runTurn({ profile: profile.id, input: { text: "…" } }, provider)) {
  // …
}
```

`createProvider` routes from `profile.model.protocol` / `provider`. Speech roles use the same call — Interactions when Google, `/audio/speech` when openAi/openrouter (same `openRouter` credentials).

| Profile | Transport |
| :--- | :--- |
| `geminiInteractions` + `google` | Google Interactions (chat, image, speech) |
| `openAi` + `openrouter` (chat) | OpenRouter chat completions |
| `openAi` + `openrouter` (speech role) | OpenRouter `/audio/speech` |

Advanced payload helpers live under `theorum/openrouter` (`toOpenRouterPayload`, …). Prefer `createProvider` for turns.

---

## Public Entrypoints

| Entrypoint | Purpose |
| :--- | :--- |
| `jsr:@theorum/core` / `theorum` | Main kernel API: profiles, schemas, runner, core types, provider constructors. |
| `jsr:@theorum/core/kernel` / `theorum/kernel` | Profile/turn types, tool catalog, `requireModelSpec`, thinking clamps over host model maps. |
| `jsr:@theorum/core/providers` / `theorum/providers` | `createProvider` + Gemini vault types. |
| `jsr:@theorum/core/openrouter` / `theorum/openrouter` | OpenRouter payload helpers (advanced). |
| `jsr:@theorum/core/guardrails` / `theorum/guardrails` | Sanitization, public error mapping, inbound injection/sensitive-data primitives. |
| `jsr:@theorum/core/observability` / `theorum/observability` | Trace sinks and trace record helpers. |
| `jsr:@theorum/core/host` / `theorum/host` | Optional Deno HTTP helpers (`json`, status mapping, cutout mint flush). |
| `jsr:@theorum/core/cli` / `theorum/cli` | Profile inspection and stress-test CLI (`theorum` binary on npm). |
| `jsr:@theorum/core/presets` / `theorum/presets` | Optional convenience packs (`registerGooglePreset`, …). |
| `jsr:@theorum/core/presets/google` / `theorum/presets/google` | Google builtins (search/maps/urlContext) + Interactions/OpenRouter wire metadata. |

Internal files remain present in source for maintainability, but package consumers should use the public entrypoints above.

---

## Development

```bash
npm install
npm run test
npm run lint
deno publish --dry-run --allow-dirty
```

Run the packaged CLI locally:

```bash
deno task theorum --help
# or after npm install -g / npx:
# npx theorum --help
```

Build the npm package from the Deno source (publish only from `npm/`):

```bash
npm run build:npm
cd npm
npm pack
```

---

## Package Boundary

THEORUM is ready for host applications when these statements stay true:

```toml
[boundary]
profiles_in_package = false
env_files_in_package = false
ambient_secret_reads = false
business_logic_in_kernel = false
provider_keys_host_owned = true
trace_sinks_host_injected = true
realtime_duplex_voice = "out of scope"
```

If an app needs domain rules, platform delivery policy, product copy, database access, or session memory, that belongs outside THEORUM.

---

## License

MIT License. Copyright (c) ORCHID AI LLC.
