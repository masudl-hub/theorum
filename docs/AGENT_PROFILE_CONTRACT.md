# Theorum Profile Specification

A **Profile** is the deterministic, typed security and behavioral contract for an agent role in Theorum.

Every profile strictly namespaces its capabilities across 6 functional domains:
1. `identity` — Persona, display handle, and static base system prompts.
2. `model` — Protocol, provider backend, model whitelist, thinking level, and controls.
3. `tools` — Tool access ceiling.
4. `inputs` — Strict ingress constraints, file limits, and routing slots.
5. `outputs` — Structured schemas, voice, media, streaming, and validation/auto-repair.
6. `guardrails` — Rate limits, canary leak detection, content safety, and outbound disclosure policies.

---

## 1. Authoring Shape

Host apps should author profile definitions, not hand-build normalized runtime
profiles. The minimum useful profile is:

```typescript
defineProfile({
  id: 'host.agent',
  model: { allow: ['your-model-id'] },
});
```

Everything except `id` and `model.allow` is optional at authoring time:

```typescript
export type ProfileDefinition = {
  id: ProfileId;
  identity?: Partial<Profile['identity']>;
  model: Partial<Profile['model']> & Pick<Profile['model'], 'allow'>;
  tools?: Partial<Profile['tools']>;
  inputs?: Partial<Profile['inputs']>;
  outputs?: Partial<Profile['outputs']>;
  guardrails?: Partial<Profile['guardrails']>;
};
```

`defineProfile()` and `registerProfile()` normalize this shape into a complete
runtime `Profile`.

## 2. Runtime Type Definition

```typescript
export interface Profile {
  /** Unique host-defined profile identifier. */
  id: ProfileId;

  /** 1. Identity & Persona */
  identity: {
    handle: string;
    chat?: boolean;
    system?: string;
    systemByRole?: Record<string, string>;
  };

  /** 2. Model & Execution Bounds */
  model: {
    protocol: 'geminiInteractions' | 'openAi';
    provider: 'google' | 'openrouter';
    allow: ModelId[];
    select?: Record<string, ModelId>;
    thinking?: ThinkingLevel | Record<string, ThinkingLevel>;
    controls?: ControlId[];
    maxSteps?: number;
    key?: GeminiFreeBucket;
  };

  /** 3. Tools Envelope */
  tools: {
    allow: ToolId[];
  };

  /** 4. Ingress (Input constraints & slots) */
  inputs: {
    text?: boolean;
    attachments?: { accept: string[] };
    voice?: { accept: string[] };
    maxFiles?: number;
    maxBytes?: number;
    maxTurnBytes?: number;
    limitsByMime?: Record<string, number>;
    slots?: Record<string, string[]>;
  };

  /** 5. Outputs (Structured output, voice, media, validation, streaming) */
  outputs: {
    structured?: StructuredSchemaId | StructuredBySlot | null;
    media?: boolean;
    voice?: ProfileVoiceSpec;
    validation?: ProfileValidationSpec;
    streaming?: ProfileStreamingSpec;
  };

  /** 6. Guardrails (Policies & safety boundaries) */
  guardrails: {
    quota?: { perDay: number };
    canary?: boolean;
    sanitizeInput?: boolean;
    redactSensitive?: boolean;
    egress?: ProfileEgressSpec;
  };
}
```

---

## 3. Field Reference

### `identity`
- `identity.handle`: Public-facing display handle for the persona.
- `identity.chat`: Flag marking whether this profile participates in interactive chat.
- `identity.system`: Base system prompt block. Fenced and bound by Theorum guardrails.
- `identity.systemByRole`: Role-specialized system prompts (e.g., `{ reviewer: '...', drafter: '...' }`).

### `model`
- `model.protocol`: Wire framing protocol (`'geminiInteractions'` for Google Interactions API, `'openAi'` for OpenAI/OpenRouter compatible chat completions API).
- `model.provider`: Provider execution backend (`'google'` or `'openrouter'`).
- `model.allow`: Whitelist of allowable `ModelId`s for this profile.
- `model.select`: Named model mappings (e.g. `{ fast: 'gemini35FlashLite', deep: 'gemini31ProPreview' }`).
- `model.thinking`: Pinned thinking level (`'minimal' | 'low' | 'medium' | 'high'`) when not user-controllable.
- `model.controls`: User-togglable controls on this profile (e.g. `['thinking']`).
- `model.maxSteps`: Step limit on autonomous tool loops (1 = one-shot; >1 = autonomous tool loop).
- `model.key`: Gemini free bucket quota pool (`'freeA' | 'freeB' | 'freeC'`).

### `tools`
- `tools.allow`: Whitelist of tool IDs permitted to run under this profile. Calls to unlisted tools are blocked at the kernel boundary.

### `inputs`
- `inputs.text`: Boolean flag accepting user text input.
- `inputs.attachments`: Allowed mime types for uploaded file attachments.
- `inputs.voice`: Allowed mime types for recorded audio clips.
- `inputs.maxFiles`: Maximum number of files permitted per message.
- `inputs.maxBytes`: Maximum byte size permitted per single file.
- `inputs.maxTurnBytes`: Maximum total byte size permitted across all files in one turn.
- `inputs.limitsByMime`: Granular per-MIME byte limits (e.g. `{ 'application/pdf': 50 * 1024 * 1024, 'video/*': 100 * 1024 * 1024 }`).
- `inputs.slots`: Allowed values for dynamic routing slots.

### `outputs`
- `outputs.structured`: Structured JSON schema specification (or slot-based schema routing).
- `outputs.media`: Flag enabling native image generation output.
- `outputs.voice`: Voice specification for TTS (`voice.voice`, `voice.responseFormat: 'pcm' | 'mp3'`).
- `outputs.validation`: In-harness auto-correction validator (`validate`, optional `extract`, `maxRetries`, `repairGuidance`). If `extract` is omitted, the structured output itself is validated.
- `outputs.streaming`: SSE streaming behaviors (`streamThoughts`, `gateMedia`).

### `guardrails`
- `guardrails.quota.perDay`: Optional daily turn quota enforced per client IP. If omitted, quota enforcement is explicitly `not_configured`.
- `guardrails.canary`: Enable unique token canary leak interception (default `true`).
- `guardrails.sanitizeInput`: Run prompt injection / jailbreak redaction on ingress text (default `true`).
- `guardrails.redactSensitive`: Redact SSN, credit cards, IP addresses, API keys from inputs (default `true`).
- `guardrails.egress`: Generic outbound disclosure control engine (`enforce`, `onBlock: 'reject_to_agent' | 'refuse_to_user'`, `maxRetries`, `repairGuidance`). Runs deterministic auto-repair loops for chat or immediate in-character refusal for voice.

### Per-turn Interactions state
- `TurnRequest.input`: Optional turn input object. If omitted, Theorum normalizes it to an empty input and still runs the profile/provider turn.
- `TurnRequest.previousInteractionId`: Optional Google Interactions server-side conversation pointer. Theorum passes it through as `previous_interaction_id` for profiles using `geminiInteractions`.
- `TurnRequest.store`: Optional Google Interactions storage override. If omitted, Theorum does not send `store`; provider/project policy remains the authority. If supplied, Theorum serializes the explicit boolean.

### Grounding events
- `TurnEvent.type: 'grounding'`: Provider evidence passthrough for Google Search / Maps grounding. The event carries raw `groundingMetadata`, raw `groundingChunks`, optional search widget HTML, and lightweight `sources` for maps/web URIs. Host apps own domain-specific interpretation, such as store cards or citation display.
